import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ActivationRuntime, DoubleClapProvider, type ClapListener } from "activation-core";
import { installCatalogue, nodeSystemProbe, nodeUptimeSource } from "host-tools";
import { MemoryRuntime, SqliteMemoryStore } from "memory-core";
import { REALTIME_INPUT_FORMAT, GeminiLiveProvider, RealtimeCore } from "realtime-core";
import { StateRuntime } from "state-core";
import { AllowlistPolicy, ToolRegistry, ToolRuntime } from "tool-system";
import { AssistantRuntime } from "./runtime.js";
import { ActivationCoreAdapter, RealtimeCoreAdapter, asDiagnosticComponent } from "./adapters.js";
import { ConversationMemoryWriter } from "./conversation-memory.js";
import { ModularSpeechDriver } from "./modular.js";
import { ToolSystemRealtimeToolExecutor } from "./tool-bridge.js";
import { createPlatformServices } from "./platform/factory.js";
import type { PlatformServices } from "./platform/contracts.js";
import type { ComponentHealth, RealtimeToolExecutor, RuntimeComponent, StatePublisher } from "./contracts.js";
import type { RuntimeSettings } from "./config.js";

export interface AssistantComposition { runtime: AssistantRuntime; memory?: MemoryRuntime; state?: StateRuntime; tools?: ToolRuntime; components: RuntimeComponent[]; platform: PlatformServices; }
export interface AssistantCompositionOptions {
  microphoneFactory?: () => Promise<{ on(event: "data", listener: (chunk: Buffer) => void): unknown; off?(event: "data", listener: (chunk: Buffer) => void): unknown; stop(): void }>;
  realtimeToolExecutor?: RealtimeToolExecutor;
  /** Overrides the platform leaf. Production omits it and gets `process.platform`. */
  platform?: PlatformServices;
}

/** Reports an absent platform leaf as a degraded component instead of crashing or faking support. */
function unavailableComponent(id: string, reason: string, extra: Record<string, unknown> = {}): RuntimeComponent {
  return {
    id,
    start: async () => undefined,
    stop: async () => undefined,
    health: async (): Promise<ComponentHealth> => ({ state: "degraded", detail: reason }),
    capabilities: async () => ({ available: false, reason, ...extra }),
  };
}

const DEFAULT_REALTIME_TOOLS = ["get_time", "calculate", "uptime", "system_status"] as const;

function createDefaultToolRuntime(trace: (event: Record<string, unknown>) => void): ToolRuntime {
  const registry = new ToolRegistry();
  const report = installCatalogue(registry, { uptime: nodeUptimeSource(), system: nodeSystemProbe() });
  if (report.failed.length > 0) trace({ type: "tools.install.failed", tools: report.failed.map((failure) => failure.message) });
  return new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [...DEFAULT_REALTIME_TOOLS] }) });
}

function toolComponent(runtime: ToolRuntime): RuntimeComponent {
  let started = false;
  return {
    id: "tools",
    start: async () => { await runtime.start(); started = true; },
    stop: async () => { await runtime.stop(); started = false; },
    health: async (): Promise<ComponentHealth> => ({ state: started ? "healthy" : "unhealthy" }),
    capabilities: async () => ({ tools: runtime.discover().map((tool) => tool.name) }),
  };
}

function redact(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function statePublisher(state: StateRuntime | undefined, trace: (event: Record<string, unknown>) => void): StatePublisher | undefined {
  if (!state) return undefined;
  return { set: async (input) => { try { return await state.set(input); } catch (error) { trace({ type: "state.publish.failed", key: input.key, message: redact(error) }); return undefined; } } };
}

async function memoryInstruction(memory: MemoryRuntime | undefined): Promise<string | undefined> {
  if (!memory) return undefined;
  const results = await memory.search({ limit: 20 });
  const lines = results.map(({ memory: record }) => {
    const content = record.content.type === "text" ? record.content.text : JSON.stringify(record.content.value);
    return `- ${record.kind}: ${content}`;
  }).join("\n");
  return lines ? `Use these durable user-approved facts when relevant:\n${lines.slice(0, 4000)}` : undefined;
}

export async function createAssistantRuntime(settings: RuntimeSettings, trace: (event: Record<string, unknown>) => void = () => {}, options: AssistantCompositionOptions = {}): Promise<AssistantComposition> {
  const platform = options.platform ?? createPlatformServices();
  const platformAvailable = platform.capability.status !== "unsupported";
  const platformReason = platform.capability.reason ?? `Platform '${platform.id}' has no adapter.`;
  if (!platformAvailable) trace({ type: "platform.unsupported", platform: platform.id, reason: platformReason });
  const state = settings.state.enabled ? new StateRuntime() : undefined;
  const memory = settings.memory.enabled ? new MemoryRuntime({ store: new SqliteMemoryStore({ path: settings.memory.path }) }) : undefined;
  const conversationMemory = memory ? new ConversationMemoryWriter(memory, settings.memory.scopeSubjectId, trace) : undefined;
  if (memory) await mkdir(dirname(settings.memory.path), { recursive: true });

  const clap = new DoubleClapProvider({ id: "double-clap", minimumIntervalMs: settings.activation.minimumIntervalMs, maximumIntervalMs: settings.activation.maximumIntervalMs, amplitudeThreshold: settings.activation.amplitudeThreshold });
  const activationCore = new ActivationRuntime({ providers: [clap] });
  const activation = new ActivationCoreAdapter(activationCore, (event) => trace({ type: "activation.detected", ...event }));
  const tools = options.realtimeToolExecutor ? undefined : createDefaultToolRuntime(trace);
  const realtimeToolExecutor = options.realtimeToolExecutor ?? (tools ? new ToolSystemRealtimeToolExecutor(tools) : undefined);
  const realtimeCore = new RealtimeCore(new GeminiLiveProvider());
  const realtime = new RealtimeCoreAdapter(realtimeCore, async () => ({ provider: settings.realtime.provider, model: settings.realtime.model, inputFormat: { ...REALTIME_INPUT_FORMAT }, systemInstruction: await memoryInstruction(memory) }), (event) => {
    trace(event);
    const type = String(event.type);
    const publisher = statePublisher(state, trace);
    if (type === "realtime.input.speech_started") void publisher?.set({ key: "speech.input", value: "speaking", source: { sourceType: "system", sourceId: settings.assistantId } });
    if (type === "realtime.transcript.final" && event.source === "input") void publisher?.set({ key: "speech.input", value: "idle", source: { sourceType: "system", sourceId: settings.assistantId } });
    if (type === "realtime.output.audio_started") void publisher?.set({ key: "speech.output", value: "speaking", source: { sourceType: "system", sourceId: settings.assistantId } });
    if (type === "realtime.output.audio_completed" || type === "realtime.output.interrupted") void publisher?.set({ key: "speech.output", value: "idle", source: { sourceType: "system", sourceId: settings.assistantId } });
  }, (event) => void conversationMemory?.handle(event), realtimeToolExecutor, platform.player);
  const modular = settings.mode === "modular" && platformAvailable ? new ModularSpeechDriver({ speech: platform.createSpeechStack(), memory, memorySubjectId: settings.memory.scopeSubjectId, trace }) : undefined;

  const microphone: ClapListener | undefined = platformAvailable
    ? platform.createActivationListener(clap, { sourceId: settings.activation.sourceId, device: settings.activation.device, onFrame: (frame) => { if (settings.mode === "native_realtime") void realtime.sendMicrophonePcm(frame); modular?.pushMicrophonePcm(frame); }, ...(options.microphoneFactory ? { microphoneFactory: options.microphoneFactory } : {}) })
    : undefined;
  const microphoneComponent: RuntimeComponent = microphone
    ? { id: "microphone", start: () => microphone.start(), stop: () => microphone.stop(), health: async (): Promise<ComponentHealth> => ({ state: microphone.isRunning() ? "healthy" : "unhealthy" }), capabilities: async () => ({ pcmInput: true, rawAudioPersistence: false, platform: platform.id }) }
    : unavailableComponent("microphone", platformReason, { pcmInput: false, platform: platform.id });
  const playbackComponent: RuntimeComponent = platformAvailable
    ? { id: "playback", start: async () => undefined, stop: async () => undefined, health: async () => ({ state: "healthy" as const }), capabilities: async () => ({ executable: platform.player.executable, sampleRate: settings.realtime.outputSampleRate, platform: platform.id }) }
    : unavailableComponent("playback", platformReason, { platform: platform.id });
  const components: RuntimeComponent[] = [
    ...(tools ? [toolComponent(tools)] : []),
    ...(memory ? [{
      id: "memory",
      start: () => memory.start(),
      stop: async () => { await conversationMemory?.flush(); await memory.stop(); },
      health: () => memory.health(),
      capabilities: async () => ({ ...(await memory.capabilities()) }),
    }] : []),
    ...(state ? [asDiagnosticComponent("state", state)] : []),
    ...(settings.mode === "modular"
      ? [modular ? asDiagnosticComponent("modular", modular) : unavailableComponent("modular", platformReason, { platform: platform.id })]
      : [{ id: "realtime", start: async () => undefined, stop: async () => realtime.stop(), health: () => realtime.health(), capabilities: () => realtime.capabilities() }]),
    playbackComponent,
    activation,
    microphoneComponent,
  ];
  const publisher = statePublisher(state, trace);
  const runtime = new AssistantRuntime({ assistantId: settings.assistantId, mode: settings.mode, inactivityMs: settings.inactivityMs, state: publisher }, { components, activation, nativeRealtime: settings.mode === "native_realtime" ? realtime : undefined, modular });
  return { runtime, memory, state, tools, components, platform };
}
