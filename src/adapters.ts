import { ActivationRuntime, type ActivationEvent } from "activation-core";
import { RealtimeCore, type RealtimeSessionConfig, type RealtimeSpeechSession } from "realtime-core";
import { IntelligenceRuntime } from "intelligence-core";
import { VoiceRuntime } from "voice-core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Activation, ActivationSource, ComponentHealth, NativeRealtimeDriver, RuntimeComponent } from "./contracts.js";

/** Adapts Activation Core's async event stream without importing its internals. */
export class ActivationCoreAdapter implements ActivationSource {
  readonly id = "activation"; private handlers = new Set<(value: Activation) => void>(); private task?: Promise<void>;
  constructor(private readonly core: ActivationRuntime, private readonly onDetected?: (value: Activation) => void) {}
  async start(): Promise<void> { await this.core.start(); this.task = this.consume(); }
  async stop(): Promise<void> { await this.core.stop(); await this.task; }
  async health(): Promise<ComponentHealth> { const health = await this.core.health(); return { state: health.state }; }
  subscribe(handler: (value: Activation) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  private async consume(): Promise<void> { for await (const event of this.core.events()) if (event.type === "activation.detected") this.emit(event); }
  private emit(event: ActivationEvent): void { const activation = { activationId: event.activationId, timestamp: event.timestamp, source: event.sourceId }; this.onDetected?.(activation); for (const handler of this.handlers) handler(activation); }
}

/** Adapts Realtime Core sessions to the runtime's provider-neutral native driver. */
export class RealtimeCoreAdapter implements NativeRealtimeDriver {
  constructor(private readonly core: RealtimeCore, private readonly config: RealtimeSessionConfig) {}
  async open(): Promise<{ close(): Promise<void>; done: Promise<void> }> {
    const session: RealtimeSpeechSession = await this.core.connect(this.config);
    let player: ChildProcessWithoutNullStreams | undefined;
    const done = (async () => { for await (const event of session.events()) {
      if (event.type === "output.audio_chunk") { player ??= spawn("ffplay.exe", ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0"], { stdio: "pipe", windowsHide: true }); player.stdin.write(Buffer.from(event.frame.data.buffer, event.frame.data.byteOffset, event.frame.data.byteLength)); }
      if (event.type === "session.closed" || event.type === "session.error") { player?.stdin.end(); return; }
    } })();
    await session.sendText("Pozdrav uživatele stručně česky: Dobrý den, jsem připraven pomoci.");
    return { close: async () => { player?.stdin.end(); await session.close(); }, done };
  }
}

/** Public Intelligence and Voice contracts form the output half of modular mode. */
export class IntelligenceVoiceAdapter {
  constructor(private readonly intelligence: IntelligenceRuntime, private readonly voice: VoiceRuntime) {}
  async respond(input: { interactionId: string; text: string }): Promise<void> {
    const result = await this.intelligence.execute({ request_id: input.interactionId, session_id: input.interactionId, input: { type: "text", text: input.text } });
    const text = result.outputs.find((output): output is { type: "text"; text: string } => output.type === "text")?.text;
    if (text) await this.voice.speak({ requestId: input.interactionId, text });
  }
}

export function asComponent(id: string, runtime: { start(): Promise<void>; stop(): Promise<void>; health(): Promise<{ state: "healthy" | "degraded" | "unhealthy" }> }): RuntimeComponent {
  return { id, start: () => runtime.start(), stop: () => runtime.stop(), health: async () => ({ state: (await runtime.health()).state }) };
}
