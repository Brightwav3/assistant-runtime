import { randomUUID } from "node:crypto";
import { ComponentRegistry, EventBus } from "core-runtime";
import type { Activation, ActivationSource, AssistantCapabilities, AssistantHealth, ComponentHealth, InteractionMode, InteractionStatus, ModularDriver, NativeRealtimeDriver, RuntimeComponent, RuntimeConfig, RuntimeStatus } from "./contracts.js";
import { AssistantRuntimeError } from "./contracts.js";

export interface RuntimeDependencies { components: RuntimeComponent[]; activation?: ActivationSource; nativeRealtime?: NativeRealtimeDriver; modular?: ModularDriver }

/** Core Runtime owns component lifecycle, health and failure isolation; this runtime owns interactions. */
function hosted(component: RuntimeComponent) {
  return { id: component.id, name: component.id, version: "0.1.0", required: component.required ?? true, start: () => component.start(), stop: () => component.stop(), health: () => component.health(), ...(component.capabilities ? { capabilities: () => component.capabilities!() } : {}) };
}

export class AssistantRuntime {
  private readonly registry: ComponentRegistry;
  private lifecycle: RuntimeStatus["state"] = "created";
  private current: InteractionStatus | null = null;
  private unsubscribe?: () => void;
  private abort?: AbortController;
  private timeout?: ReturnType<typeof setTimeout>;
  private closeSession?: () => Promise<void>;

  constructor(private readonly config: RuntimeConfig, private readonly dependencies: RuntimeDependencies) {
    if (!config.assistantId || config.inactivityMs < 1) throw new AssistantRuntimeError("CONFIGURATION_INVALID", "assistantId and a positive inactivityMs are required.");
    this.registry = new ComponentRegistry(new EventBus());
    for (const component of dependencies.components) this.registry.register(hosted(component));
  }
  async start(): Promise<void> {
    if (this.lifecycle === "running") return;
    await this.registry.startAll();
    this.lifecycle = "running";
    if (this.dependencies.activation) this.unsubscribe = this.dependencies.activation.subscribe((activation) => { void this.activate(activation); });
  }
  async stop(): Promise<void> {
    if (this.lifecycle !== "running") { this.lifecycle = "stopped"; return; }
    await this.cancel(); this.unsubscribe?.(); this.unsubscribe = undefined;
    await this.registry.stopAll();
    this.lifecycle = "stopped";
  }
  async activate(activation?: Activation): Promise<InteractionStatus | null> {
    this.assertRunning(); if (this.current) return null;
    const interaction: InteractionStatus = { interactionId: randomUUID(), activationId: activation?.activationId, mode: this.config.mode, state: "activating", startedAt: new Date().toISOString() };
    this.current = interaction; this.abort = new AbortController(); await this.publish(true, interaction);
    this.armInactivity(interaction.interactionId);
    try {
      interaction.state = "active";
      if (this.config.mode === "native_realtime") await this.runNative(interaction);
      else await this.runModular(interaction);
      return interaction;
    } catch (error) {
      if (this.current?.interactionId === interaction.interactionId) {
        interaction.state = "failed";
        await this.publishError(error);
        await this.finish(interaction);
      }
      throw error;
    }
  }
  async cancel(interactionId?: string): Promise<void> {
    if (!this.current) { if (interactionId) throw new AssistantRuntimeError("INTERACTION_NOT_FOUND", "Interaction does not exist."); return; }
    if (interactionId && interactionId !== this.current.interactionId) throw new AssistantRuntimeError("INTERACTION_NOT_FOUND", "Interaction does not exist.");
    this.abort?.abort(); await this.closeSession?.(); await this.finish(this.current);
  }
  status(): RuntimeStatus { return { state: this.lifecycle, interaction: this.current ? { ...this.current } : null }; }
  async health(): Promise<AssistantHealth> {
    const entries = (await this.registry.list()).map((record) => [record.id, record.health] as const);
    const components = Object.fromEntries(entries) as Record<string, ComponentHealth>; const values = Object.values(components);
    return { state: values.some((health) => health.state === "unhealthy") ? "unhealthy" : values.some((health) => health.state === "degraded") ? "degraded" : "healthy", components };
  }
  capabilities(): AssistantCapabilities { return { activation: Boolean(this.dependencies.activation), nativeRealtime: Boolean(this.dependencies.nativeRealtime), modular: Boolean(this.dependencies.modular), state: Boolean(this.config.state) }; }
  componentCapabilities(): Promise<Record<string, Record<string, unknown>>> { return this.registry.capabilities(); }
  private async runNative(interaction: InteractionStatus): Promise<void> {
    const driver = this.dependencies.nativeRealtime; if (!driver) throw new AssistantRuntimeError("MODE_UNAVAILABLE", "Native realtime driver is not configured.");
    const session = await driver.open({ interactionId: interaction.interactionId, signal: this.abort!.signal, onActivity: () => this.armInactivity(interaction.interactionId) });
    this.closeSession = session.close;
    void session.done.finally(() => { if (this.current?.interactionId === interaction.interactionId) void this.finish(interaction); });
  }
  private async runModular(interaction: InteractionStatus): Promise<void> {
    const driver = this.dependencies.modular; if (!driver) throw new AssistantRuntimeError("MODE_UNAVAILABLE", "Modular driver is not configured.");
    void driver.run({ interactionId: interaction.interactionId, signal: this.abort!.signal, onActivity: () => this.armInactivity(interaction.interactionId) }).then(() => { if (this.current?.interactionId === interaction.interactionId) return this.finish(interaction); }).catch(() => { if (this.current?.interactionId === interaction.interactionId) { interaction.state = "failed"; return this.finish(interaction); } });
  }
  private async finish(interaction: InteractionStatus): Promise<void> {
    if (this.current?.interactionId !== interaction.interactionId) return;
    clearTimeout(this.timeout); interaction.state = "ending"; await this.publish(false, interaction); this.current = null; this.abort = undefined; this.closeSession = undefined;
  }
  private async publish(active: boolean, interaction: InteractionStatus): Promise<void> {
    if (!this.config.state) return;
    await this.config.state.set({ key: "interaction.active", value: active, source: { sourceType: "system", sourceId: this.config.assistantId } });
    await this.config.state.set({ key: "interaction.id", value: active ? interaction.interactionId : "", source: { sourceType: "system", sourceId: this.config.assistantId } });
    await this.config.state.set({ key: "assistant.mode", value: interaction.mode, source: { sourceType: "system", sourceId: this.config.assistantId } });
    await this.config.state.set({ key: "speech.input", value: active ? "idle" : "idle", source: { sourceType: "system", sourceId: this.config.assistantId } });
    await this.config.state.set({ key: "speech.output", value: active ? "idle" : "idle", source: { sourceType: "system", sourceId: this.config.assistantId } });
  }
  private async publishError(error: unknown): Promise<void> {
    if (!this.config.state) return;
    await this.config.state.set({ key: "runtime.error", value: error instanceof Error ? error.message : String(error), source: { sourceType: "system", sourceId: this.config.assistantId } });
  }
  private armInactivity(interactionId: string): void {
    if (this.current?.interactionId !== interactionId) return;
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => { void this.cancel(interactionId); }, this.config.inactivityMs);
    this.timeout.unref?.();
  }
  private assertRunning(): void { if (this.lifecycle !== "running") throw new AssistantRuntimeError("RUNTIME_NOT_STARTED", "Assistant runtime is not running."); }
}
