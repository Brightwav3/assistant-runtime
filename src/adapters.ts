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

/** Single source of truth for playback invocation: preflight, tests, and streaming all use these exact arguments. */
export const PCM_PLAYER = {
  executable: "ffplay.exe",
  /** ffplay 8 removed the -ar/-ac shorthands; the raw PCM demuxer options are -sample_rate/-ch_layout. */
  args: (sampleRate: number): string[] => ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "s16le", "-sample_rate", String(sampleRate), "-ch_layout", "mono", "-i", "pipe:0"],
};

/** Preflight: proves the installed player accepts the production arguments before a user ever activates. */
export async function verifyPlayback(sampleRate = 24_000): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const child = spawn(PCM_PLAYER.executable, PCM_PLAYER.args(sampleRate), { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => resolve({ ok: false, message: `${PCM_PLAYER.executable} could not be started: ${error.message}` }));
    child.once("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, message: `${PCM_PLAYER.executable} rejected the playback arguments (exit ${code}): ${stderr.trim() || "no diagnostics"}` }));
    child.stdin.end(Buffer.alloc(Math.round(sampleRate * 0.05) * 2)); // 50 ms of silence
  });
}

/** Adapts Realtime Core sessions to the runtime's provider-neutral native driver. */
export class RealtimeCoreAdapter implements NativeRealtimeDriver {
  constructor(private readonly core: RealtimeCore, private readonly config: RealtimeSessionConfig, private readonly trace: (event: Record<string, unknown>) => void = () => {}) {}
  async open(): Promise<{ close(): Promise<void>; done: Promise<void> }> {
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    this.trace({ type: "realtime.connect.started", provider: this.config.provider });
    let session: RealtimeSpeechSession;
    try { session = await this.core.connect(this.config); }
    catch (error) { this.trace({ type: "realtime.connect.failed", message: message(error) }); throw error; }
    this.trace({ type: "realtime.connect.succeeded", sessionId: session.id });

    let player: ChildProcessWithoutNullStreams | undefined;
    let chunks = 0;
    const startPlayer = (): ChildProcessWithoutNullStreams => {
      const child = spawn(PCM_PLAYER.executable, PCM_PLAYER.args(24_000), { stdio: "pipe", windowsHide: true });
      this.trace({ type: "playback.spawned", pid: child.pid ?? null });
      child.on("error", (error) => this.trace({ type: "playback.error", message: message(error) }));
      child.stdin.on("error", (error) => this.trace({ type: "playback.stdin.error", message: message(error) }));
      child.stderr.on("data", (data: Buffer) => this.trace({ type: "playback.stderr", message: data.toString().trim() }));
      // Silent playback death is the failure this instrumentation exists to prevent: never let a non-zero exit pass unreported.
      child.on("close", (code) => { this.trace({ type: "playback.closed", code }); if (code !== 0) this.trace({ type: "runtime.error", message: `Playback process exited with code ${code} while the assistant was speaking; audio was lost.` }); });
      return child;
    };

    const done = (async () => { for await (const event of session.events()) {
      if (event.type === "output.audio_chunk") {
        player ??= startPlayer(); chunks++;
        if (chunks === 1 || chunks % 25 === 0) this.trace({ type: "playback.chunk", chunks, bytes: event.frame.data.byteLength });
        player.stdin.write(Buffer.from(event.frame.data.buffer, event.frame.data.byteOffset, event.frame.data.byteLength));
      } else this.trace({ type: `realtime.${event.type}`, ...("error" in event ? { message: (event as { error: { message: string } }).error.message } : {}), ...("text" in event ? { text: (event as { text: string }).text } : {}) });
      if (event.type === "session.closed" || event.type === "session.error") { this.trace({ type: "realtime.stream.ended", chunks }); player?.stdin.end(); return; }
    } this.trace({ type: "realtime.stream.ended", chunks }); })();

    const greeting = "Pozdrav uživatele stručně česky: Dobrý den, jsem připraven pomoci.";
    try { await session.sendText(greeting); this.trace({ type: "realtime.greeting.sent" }); }
    catch (error) { this.trace({ type: "realtime.greeting.failed", message: message(error) }); throw error; }
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
