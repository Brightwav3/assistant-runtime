import { ActivationRuntime, type ActivationEvent } from "activation-core";
import { RealtimeCore, type RealtimeSessionConfig, type RealtimeSpeechEvent, type RealtimeSpeechSession } from "realtime-core";
import { IntelligenceRuntime } from "intelligence-core";
import { VoiceRuntime } from "voice-core";
import { spawn } from "node:child_process";
import type { Activation, ActivationSource, ComponentHealth, NativeRealtimeDriver, RuntimeComponent } from "./contracts.js";

/** Adapts Activation Core's async event stream without importing its internals. */
export class ActivationCoreAdapter implements ActivationSource {
  readonly id = "activation"; private handlers = new Set<(value: Activation) => void>(); private task?: Promise<void>;
  constructor(private readonly core: ActivationRuntime, private readonly onDetected?: (value: Activation) => void) {}
  async start(): Promise<void> { await this.core.start(); this.task = this.consume(); }
  async stop(): Promise<void> { await this.core.stop(); await this.task; }
  async health(): Promise<ComponentHealth> { const health = await this.core.health(); return { state: health.state }; }
  async capabilities(): Promise<Record<string, unknown>> { const capabilities = await this.core.capabilities(); return { activationMethods: capabilities.activationMethods, offline: capabilities.offline }; }
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

export interface PcmPlaybackSink { write(chunk: Buffer): void; end(): void; abort(): void; }

export class PcmPlaybackController {
  private sink?: PcmPlaybackSink;
  private outputId?: string;
  constructor(private readonly factory: () => PcmPlaybackSink) {}
  handle(event: RealtimeSpeechEvent): void {
    if (event.type === "output.audio_started") { this.sink?.abort(); this.sink = this.factory(); this.outputId = event.outputId; return; }
    if (event.type === "output.audio_chunk") { if (this.sink && this.outputId === event.outputId) this.sink.write(Buffer.from(event.frame.data.buffer, event.frame.data.byteOffset, event.frame.data.byteLength)); return; }
    if (event.type === "output.interrupted") { if (!event.outputId || event.outputId === this.outputId) { this.sink?.abort(); this.sink = undefined; this.outputId = undefined; } return; }
    if (event.type === "output.audio_completed" && event.outputId === this.outputId) { this.sink?.end(); this.sink = undefined; this.outputId = undefined; }
  }
  close(): void { this.sink?.end(); this.sink = undefined; this.outputId = undefined; }
  abort(): void { this.sink?.abort(); this.sink = undefined; this.outputId = undefined; }
}

function spawnPcmPlayback(sampleRate: number, trace: (event: Record<string, unknown>) => void): PcmPlaybackSink {
  const child = spawn(PCM_PLAYER.executable, PCM_PLAYER.args(sampleRate), { stdio: "pipe", windowsHide: true });
  let intentionallyAborted = false;
  trace({ type: "playback.spawned", pid: child.pid ?? null });
  child.on("error", (error) => trace({ type: "playback.error", message: error instanceof Error ? error.message : String(error) }));
  child.stdin.on("error", (error) => { if (!intentionallyAborted) trace({ type: "playback.stdin.error", message: error instanceof Error ? error.message : String(error) }); });
  child.stderr.on("data", (data: Buffer) => trace({ type: "playback.stderr", message: data.toString().trim() }));
  child.on("close", (code) => { trace({ type: "playback.closed", code }); if (code !== 0 && !intentionallyAborted) trace({ type: "runtime.error", message: `Playback process exited with code ${code} while the assistant was speaking; audio was lost.` }); });
  return { write: (chunk) => { if (child.stdin.writable) child.stdin.write(chunk); }, end: () => { if (child.stdin.writable) child.stdin.end(); }, abort: () => { intentionallyAborted = true; child.stdin.destroy(); child.kill(); } };
}

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
  private active?: RealtimeSpeechSession;
  private opening = false;
  private pendingFrames: Int16Array[] = [];
  private onActivity?: () => void;
  constructor(private readonly core: RealtimeCore, private readonly config: RealtimeSessionConfig | (() => RealtimeSessionConfig | Promise<RealtimeSessionConfig>), private readonly trace: (event: Record<string, unknown>) => void = () => {}, private readonly onSpeechEvent: (event: RealtimeSpeechEvent) => void = () => {}) {}
  async health(): Promise<ComponentHealth> { const health = await this.core.health(); return { state: health.status, detail: health.status === "healthy" ? undefined : `Realtime provider ${health.providerId} is ${health.status}.` }; }
  async capabilities(): Promise<Record<string, unknown>> { const capabilities = await this.core.capabilities(); const provider = capabilities.providers[0]; return { nativeAudio: provider.nativeAudio, inputTranscription: provider.inputTranscription, outputTranscription: provider.outputTranscription, interruption: provider.interruption, inputFormats: provider.inputFormats.map((format) => `${format.sampleRate}Hz/${format.channels}ch`) }; }
  async start(): Promise<void> {}
  async stop(): Promise<void> { await this.active?.close(); this.active = undefined; this.onActivity = undefined; }
  async open(input: { onActivity?: () => void } = {}): Promise<{ close(): Promise<void>; done: Promise<void> }> {
    this.onActivity = input.onActivity;
    const config = typeof this.config === "function" ? await this.config() : this.config;
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    this.trace({ type: "realtime.connect.started", provider: config.provider });
    this.opening = true;
    let session: RealtimeSpeechSession;
    try { session = await this.core.connect(config); }
    catch (error) { this.pendingFrames = []; this.opening = false; this.onActivity = undefined; this.trace({ type: "realtime.connect.failed", message: message(error) }); throw error; }
    this.active = session; this.trace({ type: "realtime.connect.succeeded", sessionId: session.id });
    this.opening = false;
    for (const frame of this.pendingFrames.splice(0)) await session.sendAudio({ streamId: "windows-default-microphone", timestampMs: Date.now(), format: { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 100 }, data: frame });

    const playback = new PcmPlaybackController(() => spawnPcmPlayback(24_000, this.trace));
    let chunks = 0;
    const done = (async () => { for await (const event of session.events()) {
      this.onSpeechEvent(event);
      if (event.type === "output.audio_chunk") {
        chunks++;
        if (chunks === 1 || chunks % 25 === 0) this.trace({ type: "playback.chunk", chunks, bytes: event.frame.data.byteLength });
        playback.handle(event);
      } else this.trace({ type: `realtime.${event.type}`, ...("error" in event ? { message: (event as { error: { message: string } }).error.message } : {}), ...("text" in event ? { text: (event as { text: string }).text } : {}), ...("source" in event ? { source: (event as { source: string }).source } : {}), ...("code" in event ? { code: (event as { code: number }).code } : {}), ...("reason" in event ? { reason: (event as { reason: string }).reason } : {}) });
      if (event.type !== "output.audio_chunk") playback.handle(event);
      if (event.type === "transcript.final" || event.type === "output.audio_started") this.onActivity?.();
      if (event.type === "session.closed" || event.type === "session.error") { if (this.active === session) this.active = undefined; this.onActivity = undefined; this.trace({ type: "realtime.stream.ended", chunks }); playback.close(); return; }
    } this.trace({ type: "realtime.stream.ended", chunks }); })();

    const greeting = "Pozdrav uživatele stručně česky: Dobrý den, jsem připraven pomoci.";
    try { await session.sendText(greeting); this.trace({ type: "realtime.greeting.sent" }); }
    catch (error) { this.trace({ type: "realtime.greeting.failed", message: message(error) }); throw error; }
    return { close: async () => { playback.close(); if (this.active === session) this.active = undefined; this.onActivity = undefined; await session.close(); }, done };
  }
  async sendMicrophonePcm(data: Int16Array): Promise<void> {
    const frame = data.slice();
    const session = this.active;
    if (session) {
      if (data.some((sample) => Math.abs(sample) / 32768 >= 0.02)) this.onActivity?.();
      try { await session.sendAudio({ streamId: "windows-default-microphone", timestampMs: Date.now(), format: { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 100 }, data: frame }); }
      catch (error) { if (this.active === session) this.active = undefined; this.trace({ type: "realtime.input.failed", message: error instanceof Error ? error.message : String(error) }); }
    } else if (this.opening && this.pendingFrames.length < 25) this.pendingFrames.push(frame);
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

export function asDiagnosticComponent(
  id: string,
  runtime: { start(): Promise<void>; stop(): Promise<void>; health(): Promise<{ state: "healthy" | "degraded" | "unhealthy"; detail?: string }>; capabilities?(): Promise<object> },
): RuntimeComponent {
  return {
    id,
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    health: async () => runtime.health(),
    capabilities: runtime.capabilities ? async () => Object.fromEntries(Object.entries(await runtime.capabilities!())) : undefined,
  };
}
