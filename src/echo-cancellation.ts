/**
 * The barge-in gate.
 *
 * ADR 0003 — docs/decisions/0003-barge-in-thresholds.md
 *   The decay, the floor, and the warm-up are one decision in three parts. Until
 *   echo has been measured the threshold is only the floor, and on a microphone
 *   whose echo is louder than the floor that would admit the echo itself.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AdaptiveEchoProcessor, GateEchoProcessor, resolveConfig, type AudioFrame, type EchoProcessor } from "aec-system";
import type { EchoCancellationSettings } from "./config.js";

/**
 * How fast the measured echo level falls when the room goes quieter. Roughly a 14 s
 * half-life at 20 ms frames, so a single loud burst of echo does not hold the barge-in
 * threshold up for the rest of the conversation.
 */
const ECHO_PEAK_DECAY = 0.999;

/** No sound below this is ever treated as an interruption, whatever the echo estimate says. */
const MINIMUM_BARGE_IN_LEVEL = 0.02;

/**
 * Suppressed frames observed before barge-in is allowed at all.
 *
 * Until the echo has been measured the threshold is only the floor above, which on a
 * microphone whose echo is louder than the floor would admit the echo itself. Half a second
 * of listening first costs a barge-in nobody has attempted yet and prevents the gate
 * unlocking itself with the assistant's own voice.
 */
const BARGE_IN_WARMUP_FRAMES = 25;

/**
 * Removes the assistant's own played audio from the microphone stream before it reaches
 * the realtime provider.
 *
 * This exists because the provider's voice activity detection cannot tell the assistant's
 * voice from the user's: measured on 2026-08-14, the assistant's greeting returned through
 * the microphone, was transcribed as user speech, and the assistant interrupted itself
 * before the conversation could start.
 *
 * Only the stream sent to the provider passes through here. Activation Core keeps receiving
 * raw capture, because a double clap is not echo and must still be heard while the assistant
 * is speaking.
 */
export class EchoGuard {
  private readonly adaptive?: EchoProcessor;
  private readonly gate?: EchoProcessor;
  private readonly captureFormat: AudioFrame["format"];
  private readonly referenceFormat: AudioFrame["format"];

  /**
   * Host-clock time one past the end of the audio queued for playback so far.
   *
   * The provider streams a whole utterance in a few hundred milliseconds, and the player
   * buffers it — so the moment a chunk *arrives* is not the moment it is *heard*. Stamping
   * the reference with arrival time would compress the reference timeline against the
   * capture timeline, which puts the echo outside the delay estimator's search window and
   * opens the gate while the speaker is still talking. Each chunk is therefore placed at
   * the end of the one before it, which is where a player that does not underrun will play it.
   */
  private nextReferenceMs = 0;
  /** Consecutive suppressing frames the adaptive filter has looked healthy for. */
  private healthyStreak = 0;
  private usingGate = false;
  /** Host-clock time until which a barge-in keeps capture flowing through a closed gate. */
  private bargeInUntilMs = 0;
  private loudFrames = 0;
  /**
   * Decaying peak of the capture the gate is suppressing, which is the echo as this room
   * and this microphone gain actually deliver it. Frames loud enough to be near-end speech
   * are excluded, so the estimate tracks the echo rather than the person talking over it.
   */
  private echoPeak = 0;
  private suppressedFramesObserved = 0;
  private framesProcessed = 0;
  private recorders?: { reference: WriteStream; capture: WriteStream; cleaned: WriteStream };
  /**
   * Host-clock time the recordings start at, and how many samples of each have been
   * written. The two streams only mean anything together if they share a timeline: the
   * assistant is silent for most of a conversation, so writing reference chunks back to
   * back produces a file that is 42% as long as the capture beside it and aligned with it
   * nowhere. Gaps are padded with the silence that was actually playing.
   */
  private recordEpochMs?: number;
  private referenceSamplesWritten = 0;
  private captureSamplesWritten = 0;

  constructor(
    private readonly settings: EchoCancellationSettings,
    private readonly captureSampleRate: number,
    private readonly referenceSampleRate: number,
    private readonly trace: (event: Record<string, unknown>) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    const config = resolveConfig({
      captureFormat: { sampleRate: captureSampleRate },
      gate: { tailMs: settings.tailMs, suppressionGain: settings.suppressionGain },
      delay: { maxDelayMs: settings.maxDelayMs },
    });
    // Both processors are constructed when the mode can use either, so a fallback is a
    // decision rather than a cold start: the gate needs no convergence, but the adaptive
    // filter cannot learn a path it was not fed while the gate was in charge.
    if (settings.processor !== "gate") this.adaptive = new AdaptiveEchoProcessor(config);
    if (settings.processor !== "adaptive") this.gate = new GateEchoProcessor(config);
    this.usingGate = settings.processor === "gate";
    this.captureFormat = { sampleRate: captureSampleRate, channels: 1, sampleFormat: "pcm_s16le" };
    this.referenceFormat = { sampleRate: referenceSampleRate, channels: 1, sampleFormat: "pcm_s16le" };
  }

  /** A new utterance is starting. Any audio still queued from the last one is gone. */
  playbackStarted(): void {
    this.nextReferenceMs = 0;
  }

  /**
   * Playback was aborted, so the queued audio will never be heard. Dropping the schedule
   * matters most for the gate: without it, suppression would continue for the full duration
   * of audio the user was interrupted out of hearing.
   */
  playbackStopped(): void {
    // The processors were handed audio that will never leave the speaker. Retract it, or
    // the gate suppresses and the filter subtracts for the whole duration of an utterance
    // the user interrupted precisely because they did not want to hear it.
    const at = this.now();
    this.adaptive?.dropReferenceFrom(at);
    this.gate?.dropReferenceFrom(at);
    this.nextReferenceMs = 0;
  }

  /** What the assistant is about to play. */
  pushPlayback(data: Int16Array): void {
    if (data.length === 0) return;
    const startMs = Math.max(this.now(), this.nextReferenceMs);
    this.nextReferenceMs = startMs + (data.length / this.referenceSampleRate) * 1000;
    const frame: AudioFrame = { streamId: "assistant-playback", timestampMs: startMs, format: this.referenceFormat, data };
    this.adaptive?.pushReference(frame);
    this.gate?.pushReference(frame);
    if (this.recorders) {
      this.referenceSamplesWritten = this.recordAligned(this.recorders.reference, startMs, this.referenceSamplesWritten, this.referenceSampleRate, data);
    }
  }

  /** What the microphone heard. Returns what the provider should be given instead. */
  processCapture(data: Int16Array): Int16Array {
    const frame: AudioFrame = { streamId: "local-capture", timestampMs: this.now(), format: this.captureFormat, data };
    const adaptive = this.adaptive?.process(frame);
    const gate = this.gate?.process(frame);
    this.framesProcessed += 1;

    const cleaned = this.choose(adaptive?.data, gate?.data, data, frame.timestampMs) ?? data;
    if (this.recorders) {
      const written = this.recordAligned(this.recorders.capture, frame.timestampMs, this.captureSamplesWritten, this.captureSampleRate, data);
      this.recordAligned(this.recorders.cleaned, frame.timestampMs, this.captureSamplesWritten, this.captureSampleRate, cleaned);
      this.captureSamplesWritten = written;
    }
    if (this.framesProcessed % 50 === 0) this.trace({ type: "echo.metrics", timestampMs: this.now(), ...this.metrics() });
    return cleaned;
  }

  /**
   * Full duplex whenever cancellation is actually working, suppression when it is not.
   *
   * The decision is only ever made while the gate says playback is active — with nothing
   * playing there is no echo, so there is nothing to trade the user's voice for. Returning
   * to the adaptive output needs a sustained healthy reading rather than a single frame,
   * because one good block during a pause in the assistant's speech is not convergence.
   */
  private choose(
    adaptive: Int16Array | undefined,
    gate: Int16Array | undefined,
    captured: Int16Array,
    timestampMs: number,
  ): Int16Array | undefined {
    if (!gate) return adaptive;

    const gateMetrics = this.gate!.metrics();
    if (!gateMetrics.gateSuppressing) {
      this.usingGate = false;
      this.loudFrames = 0;
      return adaptive ?? captured;
    }

    if (this.isBargingIn(captured, timestampMs)) return adaptive ?? captured;
    if (!adaptive) return gate;

    const metrics = this.adaptive!.metrics();
    const healthy = metrics.state === "converged" && metrics.erleDb >= this.settings.minErleDb;
    this.healthyStreak = healthy ? this.healthyStreak + 1 : 0;
    const wasUsingGate = this.usingGate;
    this.usingGate = wasUsingGate ? this.healthyStreak < this.settings.recoveryFrames : !healthy;
    if (this.usingGate !== wasUsingGate) {
      this.trace({
        type: this.usingGate ? "echo.fallback.gate" : "echo.fallback.adaptive",
        timestampMs: this.now(),
        erleDb: Number(metrics.erleDb.toFixed(1)),
        state: metrics.state,
      });
    }
    return this.usingGate ? gate : adaptive;
  }

  /**
   * Writes `data` at the position its timestamp implies, padding any gap with silence, and
   * returns the new write position. Without this the recordings cannot be fed back through
   * the offline CLI, because a delay measured between two files that do not share a
   * timeline is not the delay of anything.
   */
  private recordAligned(stream: WriteStream, startMs: number, written: number, rate: number, data: Int16Array): number {
    this.recordEpochMs ??= startMs;
    const position = Math.max(0, Math.round(((startMs - this.recordEpochMs) * rate) / 1000));
    if (position > written) stream.write(Buffer.alloc((position - written) * 2));
    const at = Math.max(position, written);
    stream.write(pcmBytes(data));
    return at + data.length;
  }

  /**
   * Whether this frame is too loud to be echo.
   *
   * The gate cannot tell the user from the assistant, but the microphone can: the echo
   * arrives attenuated by the room while the user is next to the microphone. Two consecutive
   * loud frames open a hold, so a single transient — a door, a keyboard — does not let a
   * whole utterance of echo through, and the hold keeps a sentence from being chopped up
   * once it has.
   */
  private isBargingIn(captured: Int16Array, timestampMs: number): boolean {
    if (this.settings.bargeInMargin <= 0) return false;
    if (timestampMs < this.bargeInUntilMs) return true;

    let peak = 0;
    for (let i = 0; i < captured.length; i += 1) {
      const magnitude = Math.abs(captured[i]);
      if (magnitude > peak) peak = magnitude;
    }
    const level = peak / 32768;
    this.suppressedFramesObserved += 1;
    if (this.suppressedFramesObserved <= BARGE_IN_WARMUP_FRAMES) {
      this.echoPeak = Math.max(level, this.echoPeak * ECHO_PEAK_DECAY);
      this.loudFrames = 0;
      return false;
    }

    const threshold = this.bargeInLevel();
    if (level < threshold) {
      // Only frames that look like echo update the estimate, so a barge-in cannot raise the
      // bar that admitted it and lock the user out of the next one.
      this.echoPeak = Math.max(level, this.echoPeak * ECHO_PEAK_DECAY);
      this.loudFrames = 0;
      return false;
    }

    this.loudFrames += 1;
    if (this.loudFrames < 2) return false;
    if (timestampMs >= this.bargeInUntilMs) {
      this.trace({ type: "echo.bargein", timestampMs, peak: Number(level.toFixed(3)), threshold: Number(this.bargeInLevel().toFixed(3)) });
    }
    this.bargeInUntilMs = timestampMs + this.settings.bargeInHoldMs;
    return true;
  }

  /**
   * The level a sound has to reach right now to be treated as the user rather than the
   * assistant. Floored so that a session which has heard no echo yet — or one on a
   * microphone quiet enough that the echo estimate collapses — does not open the gate for
   * room noise.
   */
  private bargeInLevel(): number {
    return Math.max(MINIMUM_BARGE_IN_LEVEL, this.settings.bargeInMargin * this.echoPeak);
  }

  /** What this guard is configured to do, readable before a session exists. */
  describe(): Record<string, unknown> {
    return {
      processor: this.settings.processor,
      tailMs: this.settings.tailMs,
      maxDelayMs: this.settings.maxDelayMs,
      suppressionGain: this.settings.suppressionGain,
      bargeInMargin: this.settings.bargeInMargin,
      minErleDb: this.settings.minErleDb,
      preservesFullDuplex: this.settings.processor !== "gate",
      recording: Boolean(this.settings.recordDir),
    };
  }

  metrics(): Record<string, unknown> {
    const adaptive = this.adaptive?.metrics();
    const gate = this.gate?.metrics();
    return {
      processor: this.usingGate ? "gate" : (this.adaptive?.id ?? "gate"),
      framesProcessed: this.framesProcessed,
      erleDb: adaptive ? Number(adaptive.erleDb.toFixed(1)) : null,
      state: adaptive?.state ?? gate?.state ?? null,
      estimatedDelayMs: adaptive?.estimatedDelayMs === undefined || adaptive?.estimatedDelayMs === null ? null : Number(adaptive.estimatedDelayMs.toFixed(1)),
      delayConverged: adaptive?.delayConverged ?? false,
      doubleTalkBlocks: adaptive?.doubleTalkBlocks ?? 0,
      divergenceEvents: adaptive?.divergenceEvents ?? 0,
      gateSuppressing: gate?.gateSuppressing ?? false,
      echoPeak: Number(this.echoPeak.toFixed(4)),
      echoMeasured: this.suppressedFramesObserved > BARGE_IN_WARMUP_FRAMES,
      bargeInLevel: Number(this.bargeInLevel().toFixed(4)),
      framesSuppressed: gate?.framesSuppressed ?? 0,
    };
  }

  /**
   * Starts writing the three streams to headerless pcm_s16le files, so a session that
   * still goes wrong leaves evidence instead of an impression. Recording is opt-in: it
   * writes the user's microphone audio to disk, which is not something to do by default.
   */
  beginSession(sessionId: string): void {
    this.reset();
    if (this.settings.recordDir) this.startRecording(this.settings.recordDir, sessionId);
  }

  startRecording(directory: string, sessionId: string, basePath = process.cwd()): void {
    void this.close();
    const target = isAbsolute(directory) ? directory : resolve(basePath, directory);
    mkdirSync(target, { recursive: true });
    this.recordEpochMs = undefined;
    this.referenceSamplesWritten = 0;
    this.captureSamplesWritten = 0;
    const path = (name: string) => resolve(target, `${sessionId}.${name}.pcm`);
    this.recorders = {
      reference: createWriteStream(path(`reference-${this.referenceSampleRate}`)),
      capture: createWriteStream(path(`capture-${this.captureSampleRate}`)),
      cleaned: createWriteStream(path(`cleaned-${this.captureSampleRate}`)),
    };
    this.trace({ type: "echo.recording.started", timestampMs: this.now(), directory: target, sessionId });
  }

  /** Resolves once the recordings are on disk, so a caller can read what a session produced. */
  async close(): Promise<void> {
    if (!this.recorders) return;
    const streams = Object.values(this.recorders);
    this.recorders = undefined;
    this.trace({ type: "echo.recording.stopped", timestampMs: this.now(), ...this.metrics() });
    await Promise.all(streams.map((stream) => new Promise<void>((done) => stream.end(done))));
  }

  reset(): void {
    this.adaptive?.reset();
    this.gate?.reset();
    this.nextReferenceMs = 0;
    this.healthyStreak = 0;
    this.framesProcessed = 0;
    this.usingGate = this.settings.processor === "gate";
    this.bargeInUntilMs = 0;
    this.loudFrames = 0;
    this.echoPeak = 0;
    this.suppressedFramesObserved = 0;
  }
}

function pcmBytes(data: Int16Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function createEchoGuard(
  settings: EchoCancellationSettings,
  captureSampleRate: number,
  referenceSampleRate: number,
  trace: (event: Record<string, unknown>) => void,
): EchoGuard | undefined {
  if (!settings.enabled) return undefined;
  return new EchoGuard(settings, captureSampleRate, referenceSampleRate, trace);
}
