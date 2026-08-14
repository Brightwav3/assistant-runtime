import { ActivationRuntime, type ActivationEvent } from "activation-core";
import { REALTIME_INPUT_FORMAT, RealtimeCore, type RealtimeSessionConfig, type RealtimeSpeechEvent, type RealtimeSpeechSession } from "realtime-core";
import { IntelligenceRuntime } from "intelligence-core";
import { VoiceRuntime } from "voice-core";
import { spawn } from "node:child_process";
import type { Activation, ActivationSource, ComponentHealth, NativeRealtimeDriver, RealtimeToolExecutor, RuntimeComponent } from "./contracts.js";
import type { PcmPlayerSpec } from "./platform/contracts.js";
import { PcmInputFrameizer, REALTIME_MICROPHONE_STREAM_ID } from "./realtime-audio.js";

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

/**
 * @deprecated Shared code must take a `PcmPlayerSpec` from the selected platform
 * leaf instead of reaching for the Windows player. Re-exported only so existing
 * callers keep resolving; nothing in this module defaults to it.
 */
export { WINDOWS_PCM_PLAYER as PCM_PLAYER } from "./platform/windows-player.js";

/** Matches the provider's documented "stream paused for more than a second" rule. */
const CAPTURE_IDLE_FLUSH_MS = 1_000;

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

/** Discards audio and says so. Used when no platform leaf supplied a player. */
function unavailablePcmPlayback(reason: string, trace: (event: Record<string, unknown>) => void): PcmPlaybackSink {
  trace({ type: "playback.unavailable", timestampMs: Date.now(), reason });
  return { write: () => undefined, end: () => undefined, abort: () => undefined };
}

function spawnPcmPlayback(sampleRate: number, trace: (event: Record<string, unknown>) => void, player: PcmPlayerSpec | undefined): PcmPlaybackSink {
  if (!player?.executable) return unavailablePcmPlayback("No platform leaf supplied a PCM player for this host.", trace);
  const child = spawn(player.executable, player.args(sampleRate), { stdio: "pipe", windowsHide: true });
  let intentionallyAborted = false;
  trace({ type: "playback.spawned", timestampMs: Date.now(), pid: child.pid ?? null });
  child.on("error", (error) => trace({ type: "playback.error", timestampMs: Date.now(), message: error instanceof Error ? error.message : String(error) }));
  child.stdin.on("error", (error) => { if (!intentionallyAborted) trace({ type: "playback.stdin.error", timestampMs: Date.now(), message: error instanceof Error ? error.message : String(error) }); });
  child.stderr.on("data", (data: Buffer) => trace({ type: "playback.stderr", timestampMs: Date.now(), message: data.toString().trim() }));
  child.on("close", (code) => { trace({ type: "playback.closed", timestampMs: Date.now(), code }); if (code !== 0 && !intentionallyAborted) trace({ type: "runtime.error", timestampMs: Date.now(), message: `Playback process exited with code ${code} while the assistant was speaking; audio was lost.` }); });
  return { write: (chunk) => { if (child.stdin.writable) child.stdin.write(chunk); }, end: () => { if (child.stdin.writable) child.stdin.end(); }, abort: () => { intentionallyAborted = true; child.stdin.destroy(); child.kill(); } };
}

/**
 * Preflight: proves the selected platform's player accepts the production
 * arguments before a user ever activates. The player is supplied by the caller
 * so no host is probed with another host's executable.
 */
export async function verifyPlayback(player: PcmPlayerSpec | undefined, sampleRate = 24_000): Promise<{ ok: boolean; message?: string }> {
  if (!player?.executable) return { ok: false, message: "No platform leaf supplied a PCM player for this host, so playback cannot be verified." };
  return new Promise((resolve) => {
    const child = spawn(player.executable, player.args(sampleRate), { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => resolve({ ok: false, message: `${player.executable} could not be started: ${error.message}` }));
    child.once("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, message: `${player.executable} rejected the playback arguments (exit ${code}): ${stderr.trim() || "no diagnostics"}` }));
    child.stdin.end(Buffer.alloc(Math.round(sampleRate * 0.05) * 2)); // 50 ms of silence
  });
}

/** Adapts Realtime Core sessions to the runtime's provider-neutral native driver. */
export class RealtimeCoreAdapter implements NativeRealtimeDriver {
  private active?: RealtimeSpeechSession;
  private opening = false;
  private pendingFrames: Int16Array[] = [];
  private onActivity?: () => void;
  private readonly frameizer = new PcmInputFrameizer();
  private inputSendChain: Promise<void> = Promise.resolve();
  private inputFramesSent = 0;
  private inputFramesDropped = 0;
  /** The provider holds captured audio until silence or an explicit end-of-stream; a paused microphone must not strand it. */
  private captureIdleTimer?: NodeJS.Timeout;
  private toolRequested = 0;
  private toolCompleted = 0;
  private toolFailed = 0;
  private toolCancelled = 0;

  constructor(
    private readonly core: RealtimeCore,
    private readonly config: RealtimeSessionConfig | (() => RealtimeSessionConfig | Promise<RealtimeSessionConfig>),
    private readonly trace: (event: Record<string, unknown>) => void = () => {},
    private readonly onSpeechEvent: (event: RealtimeSpeechEvent) => void = () => {},
    private readonly toolExecutor?: RealtimeToolExecutor,
    /** Playback spec from the platform leaf. Omitted means no playback on this host — never a Windows fallback. */
    private readonly player?: PcmPlayerSpec,
  ) {}

  async health(): Promise<ComponentHealth> {
    const health = await this.core.health();
    return { state: health.status, detail: health.status === "healthy" ? undefined : `Realtime provider ${health.providerId} is ${health.status}.` };
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const capabilities = await this.core.capabilities();
    const provider = capabilities.providers[0];
    return { nativeAudio: provider.nativeAudio, inputTranscription: provider.inputTranscription, outputTranscription: provider.outputTranscription, interruption: provider.interruption, inputFormats: provider.inputFormats.map((format) => `${format.sampleRate}Hz/${format.channels}ch`) };
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.clearCaptureIdleFlush();
    await this.active?.close();
    this.active = undefined;
    this.opening = false;
    this.pendingFrames = [];
    this.frameizer.reset();
    this.onActivity = undefined;
  }

  async open(input: { interactionId?: string; signal?: AbortSignal; onActivity?: () => void } = {}): Promise<{ close(): Promise<void>; done: Promise<void> }> {
    this.onActivity = input.onActivity;
    this.opening = true;
    this.pendingFrames = [];
    this.frameizer.reset();
    this.resetMetrics();
    const message = (error: unknown) => this.redact(error instanceof Error ? error.message : String(error));
    let config: RealtimeSessionConfig;
    try {
      config = typeof this.config === "function" ? await this.config() : this.config;
      if (this.toolExecutor) {
        const tools = await this.toolExecutor.discover();
        config = { ...config, tools };
        this.trace({ type: "realtime.tools.discovered", timestampMs: Date.now(), count: tools.length, tools: tools.map((tool) => tool.name) });
      }
    } catch (error) {
      this.opening = false;
      this.pendingFrames = [];
      this.frameizer.reset();
      this.onActivity = undefined;
      this.trace({ type: "realtime.connect.failed", timestampMs: Date.now(), message: message(error) });
      throw error;
    }

    this.trace({ type: "realtime.connect.started", timestampMs: Date.now(), provider: config.provider });
    let session: RealtimeSpeechSession;
    try {
      session = await this.core.connect(config);
    } catch (error) {
      this.pendingFrames = [];
      this.frameizer.reset();
      this.opening = false;
      this.onActivity = undefined;
      this.trace({ type: "realtime.connect.failed", timestampMs: Date.now(), message: message(error) });
      throw error;
    }

    this.active = session;
    this.opening = false;
    this.trace({ type: "realtime.connect.succeeded", timestampMs: Date.now(), sessionId: session.id });
    await this.enqueueFrames(session, this.pendingFrames.splice(0));

    const playback = new PcmPlaybackController(() => spawnPcmPlayback(24_000, this.trace, this.player));
    let chunks = 0;
    let bytesWritten = 0;
    let firstChunkAt: number | undefined;
    let playbackStartedAt: number | undefined;
    let playbackDurationMs: number | undefined;
    let abortRequested = 0;
    let abortCompleted = 0;

    const emitPlaybackMetrics = (timestampMs: number) => this.trace({ type: "realtime.playback.metrics", timestampMs, firstChunkAt: firstChunkAt ?? null, bytesWritten, chunksWritten: chunks, abortRequested, abortCompleted, durationMs: playbackDurationMs ?? null });

    const done = (async () => {
      for await (const event of session.events()) {
        this.onSpeechEvent(event);
        if (event.type === "output.audio_chunk") {
          chunks += 1;
          bytesWritten += event.frame.data.byteLength;
          firstChunkAt ??= event.timestampMs;
          if (chunks === 1 || chunks % 25 === 0) this.trace({ type: "realtime.playback.chunk", timestampMs: event.timestampMs, chunks, bytesWritten, firstChunkAt });
          playback.handle(event);
          continue;
        }

        this.traceSpeechEvent(event);
        if (event.type === "output.audio_started") playbackStartedAt = event.timestampMs;
        if (event.type === "output.interrupted") {
          abortRequested += 1;
          playback.handle(event);
          abortCompleted += 1;
          emitPlaybackMetrics(event.timestampMs);
        } else {
          playback.handle(event);
        }
        if (event.type === "input.speech_started" || (event.type === "transcript.final" && event.source === "input") || event.type === "output.audio_started" || event.type === "tool.requested") this.onActivity?.();
        if (event.type === "output.audio_completed") {
          playbackDurationMs = playbackStartedAt === undefined ? undefined : Math.max(0, event.timestampMs - playbackStartedAt);
          emitPlaybackMetrics(event.timestampMs);
        }
        if (event.type === "tool.requested") await this.handleToolRequest(session, event, input.signal);
        if (event.type === "session.closed" || event.type === "session.error") {
          if (this.active === session) this.active = undefined;
          this.clearCaptureIdleFlush();
          this.onActivity = undefined;
          playback.close();
          emitPlaybackMetrics(event.timestampMs);
          this.trace({ type: "realtime.stream.ended", timestampMs: event.timestampMs, chunks });
          return;
        }
      }
      this.trace({ type: "realtime.stream.ended", timestampMs: Date.now(), chunks });
    })();

    // The Live API waits for input before it speaks, so the opening line is prompted, not spontaneous.
    const greeting = "Pozdrav uživatele přesně touto větou a nic k ní nepřidávej: „Dobrý den, jsem MARK, jak vám mohu pomoci pane?“";
    try {
      await session.sendText(greeting);
      this.trace({ type: "realtime.greeting.sent", timestampMs: Date.now() });
    } catch (error) {
      this.trace({ type: "realtime.greeting.failed", timestampMs: Date.now(), message: message(error) });
      throw error;
    }

    return {
      close: async () => {
        playback.close();
        this.clearCaptureIdleFlush();
        if (this.active === session) this.active = undefined;
        this.opening = false;
        this.pendingFrames = [];
        this.frameizer.reset();
        this.onActivity = undefined;
        await session.close();
      },
      done,
    };
  }

  async sendMicrophonePcm(data: Int16Array): Promise<void> {
    const session = this.active;
    if (!session && !this.opening) {
      this.frameizer.reset();
      return;
    }

    if (data.some((sample) => Math.abs(sample) / 32768 >= 0.02)) this.onActivity?.();
    const frames = this.frameizer.push(data);
    if (frames.length === 0) return;

    if (!session) {
      for (const frame of frames) {
        if (this.pendingFrames.length >= 25) {
          this.pendingFrames.shift();
          this.inputFramesDropped += 1;
        }
        this.pendingFrames.push(frame);
        this.emitInputMetrics(this.inputFramesDropped > 0);
      }
      return;
    }

    await this.enqueueFrames(session, frames);
  }

  /** One second of no captured frames counts as a paused stream, matching the provider's own buffering rule. */
  private armCaptureIdleFlush(session: RealtimeSpeechSession): void {
    if (this.captureIdleTimer) clearTimeout(this.captureIdleTimer);
    if (!session.endAudioStream) return;
    this.captureIdleTimer = setTimeout(() => {
      this.captureIdleTimer = undefined;
      if (this.active !== session) return;
      void session.endAudioStream!()
        .then(() => this.trace({ type: "realtime.input.stream_ended", timestampMs: Date.now() }))
        .catch((error) => this.trace({ type: "realtime.input.stream_end_failed", timestampMs: Date.now(), message: this.redact(error instanceof Error ? error.message : String(error)) }));
    }, CAPTURE_IDLE_FLUSH_MS);
    this.captureIdleTimer.unref?.();
  }

  private clearCaptureIdleFlush(): void {
    if (this.captureIdleTimer) clearTimeout(this.captureIdleTimer);
    this.captureIdleTimer = undefined;
  }

  private enqueueFrames(session: RealtimeSpeechSession, frames: Int16Array[]): Promise<void> {
    this.armCaptureIdleFlush(session);
    for (const data of frames) {
      this.inputSendChain = this.inputSendChain.catch(() => undefined).then(async () => {
        if (this.active !== session) return;
        try {
          await session.sendAudio({ streamId: REALTIME_MICROPHONE_STREAM_ID, timestampMs: Date.now(), format: { ...REALTIME_INPUT_FORMAT }, data });
          this.inputFramesSent += 1;
          this.emitInputMetrics();
        } catch (error) {
          if (this.active === session) this.active = undefined;
          this.trace({ type: "realtime.input.failed", timestampMs: Date.now(), message: this.redact(error instanceof Error ? error.message : String(error)) });
        }
      });
    }
    return this.inputSendChain;
  }

  private async handleToolRequest(session: RealtimeSpeechSession, event: Extract<RealtimeSpeechEvent, { type: "tool.requested" }>, signal?: AbortSignal): Promise<void> {
    this.toolRequested += 1;
    this.traceToolMetrics(event.callId, event.timestampMs);
    if (signal?.aborted) {
      this.toolCancelled += 1;
      this.traceToolMetrics(event.callId, Date.now());
      return;
    }

    let result: { content: string; isError?: boolean };
    let executionFailed = false;
    try {
      result = this.toolExecutor ? await this.toolExecutor.execute({ callId: event.callId, tool: event.tool, arguments: event.arguments, signal }) : { content: "No realtime tool executor is configured.", isError: true };
    } catch (error) {
      if (signal?.aborted || this.active !== session) {
        this.toolCancelled += 1;
        this.traceToolMetrics(event.callId, Date.now());
        return;
      }
      this.toolFailed += 1;
      executionFailed = true;
      result = { content: `Realtime tool execution failed: ${this.redact(error instanceof Error ? error.message : String(error))}`, isError: true };
    }

    if (signal?.aborted || this.active !== session) {
      this.toolCancelled += 1;
      this.traceToolMetrics(event.callId, Date.now());
      return;
    }

    try {
      await session.sendToolResult({ callId: event.callId, content: result.content, ...(result.isError === undefined ? {} : { isError: result.isError }) });
      if (result.isError) { if (!executionFailed) this.toolFailed += 1; }
      else this.toolCompleted += 1;
      this.onActivity?.();
      this.traceToolMetrics(event.callId, Date.now());
    } catch (error) {
      if (!executionFailed) this.toolFailed += 1;
      this.trace({ type: "realtime.tool.result.failed", timestampMs: Date.now(), callId: event.callId, message: this.redact(error instanceof Error ? error.message : String(error)) });
      this.traceToolMetrics(event.callId, Date.now());
    }
  }

  private traceSpeechEvent(event: RealtimeSpeechEvent): void {
    const traced: Record<string, unknown> = { type: `realtime.${event.type}`, timestampMs: event.timestampMs };
    if ("sessionId" in event) traced.sessionId = event.sessionId;
    if ("providerId" in event) traced.providerId = event.providerId;
    if ("outputId" in event) traced.outputId = event.outputId;
    if ("callId" in event) { traced.callId = event.callId; traced.tool = event.tool; }
    if ("error" in event) traced.message = event.error.message;
    if ("text" in event) { traced.text = event.text; traced.source = event.source; }
    if ("code" in event) traced.code = event.code;
    if ("reason" in event) traced.reason = event.reason;
    if ("timeLeftMs" in event) traced.timeLeftMs = event.timeLeftMs;
    this.trace(traced);
  }

  private emitInputMetrics(force = false): void {
    if (!force && this.inputFramesSent > 0 && this.inputFramesSent % 25 !== 0) return;
    this.trace({ type: "realtime.input.metrics", timestampMs: Date.now(), framesSent: this.inputFramesSent, framesDropped: this.inputFramesDropped, bufferedMs: this.pendingFrames.length * 20 });
  }

  private traceToolMetrics(callId: string, timestampMs: number): void {
    this.trace({ type: "realtime.tool.metrics", timestampMs, callId, requested: this.toolRequested, completed: this.toolCompleted, failed: this.toolFailed, cancelled: this.toolCancelled });
  }

  private resetMetrics(): void {
    this.inputFramesSent = 0;
    this.inputFramesDropped = 0;
    this.toolRequested = 0;
    this.toolCompleted = 0;
    this.toolFailed = 0;
    this.toolCancelled = 0;
    this.inputSendChain = Promise.resolve();
  }

  private redact(value: string): string {
    return value.replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
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
