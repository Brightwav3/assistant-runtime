import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { EchoGuard, createEchoGuard } from "../src/echo-cancellation.js";
import type { EchoCancellationSettings } from "../src/config.js";

const CAPTURE_RATE = 16_000;
const REFERENCE_RATE = 24_000;
const CAPTURE_FRAME = 320; // 20 ms
const REFERENCE_CHUNK = 480; // 20 ms
const ECHO_DELAY_SAMPLES = 3210; // ~200 ms, the Bluetooth range measured on the failing hardware

const SETTINGS: EchoCancellationSettings = { enabled: true, processor: "auto", tailMs: 400, minErleDb: 6, recoveryFrames: 25 };

/** Deterministic PRNG, so a failure reproduces identically. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Continuous speech-like noise: the assistant talking without pause, which is the worst case for a gate. */
function speechLike(length: number, seed: number): Float32Array {
  const next = random(seed);
  const out = new Float32Array(length);
  let previous = 0;
  for (let i = 0; i < length; i += 1) {
    previous = previous * 0.6 + (next() * 2 - 1) * 0.4;
    out[i] = previous * 0.6;
  }
  return out;
}

function toInt16(values: Float32Array): Int16Array {
  const out = new Int16Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = Math.max(-32768, Math.min(32767, Math.round(values[i] * 32768)));
  return out;
}

function peak(data: Int16Array): number {
  let highest = 0;
  for (const sample of data) highest = Math.max(highest, Math.abs(sample));
  return highest;
}

/**
 * One conversation's worth of audio: what the assistant played at 24 kHz, and what the
 * microphone heard at 16 kHz — the same signal, delayed and attenuated by the room.
 */
function scenario(seconds: number, seed = 11) {
  const played24 = speechLike(REFERENCE_RATE * seconds, seed);
  // Linear interpolation, matching how the runtime brings the 24 kHz reference onto the
  // 16 kHz capture clock. A cruder resampler here would model an echo the filter has no
  // way to reproduce, and the test would measure the mismatch instead of the canceller.
  const played16 = new Float32Array(CAPTURE_RATE * seconds);
  for (let i = 0; i < played16.length; i += 1) {
    const source = i * 1.5;
    const low = Math.floor(source);
    const high = Math.min(low + 1, played24.length - 1);
    played16[i] = played24[low] * (1 - (source - low)) + played24[high] * (source - low);
  }
  const heard = new Float32Array(played16.length);
  for (let i = ECHO_DELAY_SAMPLES; i < heard.length; i += 1) heard[i] = played16[i - ECHO_DELAY_SAMPLES] * 0.35;
  return { reference: toInt16(played24), capture: toInt16(heard) };
}

interface RunOptions {
  seconds: number;
  settings?: Partial<EchoCancellationSettings>;
  recordDir?: string;
  stopPlaybackAtFrame?: number;
}

async function run(options: RunOptions) {
  const { reference, capture } = scenario(options.seconds);
  let clock = 1_000_000;
  const traces: Record<string, unknown>[] = [];
  const settings = { ...SETTINGS, ...(options.settings ?? {}), ...(options.recordDir ? { recordDir: options.recordDir } : {}) };
  const guard = new EchoGuard(settings, CAPTURE_RATE, REFERENCE_RATE, (event) => void traces.push(event), () => clock);
  guard.beginSession("test-session");

  const outputs: Int16Array[] = [];
  const processorPerFrame: string[] = [];
  const frames = Math.floor(capture.length / CAPTURE_FRAME);
  for (let index = 0; index < frames; index += 1) {
    if (options.stopPlaybackAtFrame === index) guard.playbackStopped();
    if (options.stopPlaybackAtFrame === undefined || index < options.stopPlaybackAtFrame) {
      const offset = index * REFERENCE_CHUNK;
      guard.pushPlayback(reference.subarray(offset, offset + REFERENCE_CHUNK));
    }
    outputs.push(guard.processCapture(capture.subarray(index * CAPTURE_FRAME, (index + 1) * CAPTURE_FRAME)));
    processorPerFrame.push(String(guard.metrics().processor));
    clock += 20;
  }
  await guard.close();
  return { guard, outputs, processorPerFrame, traces, capture, frames };
}

test("the reference is scheduled by playback position, not by arrival time", () => {
  // The provider delivers a whole utterance in a burst. Stamping chunks with arrival time
  // would compress the reference timeline and put the echo outside the search window.
  const pushed: number[] = [];
  const clock = 500_000;
  const guard = new EchoGuard(SETTINGS, CAPTURE_RATE, REFERENCE_RATE, () => {}, () => clock);
  const chunk = toInt16(speechLike(REFERENCE_CHUNK, 3));
  const recordingGuard = guard as unknown as { nextReferenceMs: number };

  for (let i = 0; i < 10; i += 1) {
    guard.pushPlayback(chunk);
    pushed.push(recordingGuard.nextReferenceMs);
  }

  // Ten 20 ms chunks delivered in the same millisecond still occupy 200 ms of playback time.
  assert.equal(pushed[0], clock + 20);
  assert.equal(pushed[9], clock + 200);
  for (let i = 1; i < pushed.length; i += 1) assert.ok(pushed[i] > pushed[i - 1], "the schedule must advance monotonically");
});

test("an interrupted utterance drops the rest of the schedule", () => {
  // Barge-in kills the player, so audio that was queued is never heard. Continuing to
  // suppress for its duration would deafen the assistant to the user who just interrupted.
  const clock = 500_000;
  const guard = new EchoGuard(SETTINGS, CAPTURE_RATE, REFERENCE_RATE, () => {}, () => clock);
  const state = guard as unknown as { nextReferenceMs: number };

  for (let i = 0; i < 100; i += 1) guard.pushPlayback(toInt16(speechLike(REFERENCE_CHUNK, 4)));
  assert.ok(state.nextReferenceMs > clock + 1000, "two seconds of audio should be scheduled");

  guard.playbackStopped();
  assert.equal(state.nextReferenceMs, 0);

  const speech = toInt16(speechLike(CAPTURE_FRAME, 5));
  assert.ok(peak(guard.processCapture(speech)) > 0, "the user must be heard immediately after an interruption");
});

test("nothing of the assistant's own voice reaches the provider before the filter converges", async () => {
  const { outputs, processorPerFrame } = await run({ seconds: 2 });

  // The filter needs about a second on this path. Until it has measurably converged, 'auto'
  // holds the gate, and the gate emits silence rather than an attenuated copy of the echo.
  const early = outputs.slice(0, 50);
  assert.ok(early.every((frame) => peak(frame) === 0), "early frames must be suppressed, not merely attenuated");
  assert.ok(processorPerFrame.slice(0, 50).every((processor) => processor === "gate"));
});

test("full duplex is restored once the filter is measurably cancelling", async () => {
  const { outputs, processorPerFrame, traces, frames } = await run({ seconds: 10 });

  const recovered = processorPerFrame.indexOf("adaptive");
  assert.ok(recovered > 0, "the guard never returned to the adaptive filter");
  assert.ok(recovered < frames * 0.9, `recovery took ${recovered} frames of ${frames}`);
  assert.ok(traces.some((event) => event.type === "echo.fallback.adaptive"), "the switch back must be traced");

  // Whichever processor is in charge, the assistant's own voice must not survive.
  const tail = outputs.slice(-100);
  const worst = Math.max(...tail.map(peak));
  assert.ok(worst < 32768 * 0.02, `residual echo peaked at ${(worst / 32768).toFixed(3)} of full scale`);
});

test("recording writes the played, captured, and cleaned streams for offline analysis", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "aec-record-"));
  const { frames } = await run({ seconds: 1, recordDir: directory });

  const files = readdirSync(directory).sort();
  assert.deepEqual(files, ["test-session.capture-16000.pcm", "test-session.cleaned-16000.pcm", "test-session.reference-24000.pcm"]);
  const cleaned = readFileSync(resolve(directory, "test-session.cleaned-16000.pcm"));
  assert.equal(cleaned.byteLength, frames * CAPTURE_FRAME * 2, "the cleaned recording must cover every processed frame");
});

test("gate-only and adaptive-only modes build only what they need", async () => {
  const gateOnly = await run({ seconds: 1, settings: { processor: "gate" } });
  assert.equal(gateOnly.guard.metrics().processor, "gate");
  assert.equal(gateOnly.guard.metrics().erleDb, null, "the gate reports no cancellation figure");

  const adaptiveOnly = await run({ seconds: 1, settings: { processor: "adaptive" } });
  assert.equal(adaptiveOnly.guard.metrics().processor, "adaptive");
  assert.equal(adaptiveOnly.guard.metrics().gateSuppressing, false, "an adaptive-only guard never suppresses");
});

test("disabled configuration produces no guard at all", () => {
  assert.equal(createEchoGuard({ ...SETTINGS, enabled: false }, CAPTURE_RATE, REFERENCE_RATE, () => {}), undefined);
  assert.ok(createEchoGuard(SETTINGS, CAPTURE_RATE, REFERENCE_RATE, () => {}) instanceof EchoGuard);
});
