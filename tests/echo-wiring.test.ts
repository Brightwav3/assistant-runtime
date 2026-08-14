import assert from "node:assert/strict";
import test from "node:test";
import type { AudioFrame, RealtimeProviderCapabilities, RealtimeSessionConfig, RealtimeSpeechProvider, RealtimeSpeechEvent, RealtimeSpeechSession } from "realtime-core";
import { PcmPlaybackController, RealtimeCoreAdapter } from "../src/adapters.js";
import { EchoGuard } from "../src/echo-cancellation.js";
import type { EchoCancellationSettings } from "../src/config.js";

/**
 * Proves the two ends of the loop are actually connected: what the assistant plays reaches
 * the canceller as a reference, and what reaches the provider is the cleaned capture. The
 * cancellation itself is covered in echo-cancellation.test.ts.
 */

const SETTINGS: EchoCancellationSettings = { enabled: true, processor: "gate", tailMs: 400, minErleDb: 6, recoveryFrames: 25 };
const INPUT_FORMAT = { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le" as const, frameDurationMs: 20 };

class FakeSession implements RealtimeSpeechSession {
  readonly id = "wiring-session";
  private closed = false;
  readonly receivedFrames: AudioFrame[] = [];
  private queue: RealtimeSpeechEvent[] = [];
  private waiters: Array<() => void> = [];
  async sendAudio(frame: AudioFrame): Promise<void> { this.receivedFrames.push({ ...frame, data: frame.data.slice() }); }
  async sendText(): Promise<void> {}
  async sendToolResult(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> { if (this.closed) return; this.closed = true; for (const resolve of this.waiters.splice(0)) resolve(); }
  async *events(): AsyncIterable<RealtimeSpeechEvent> { while (!this.closed || this.queue.length) { if (!this.queue.length) await new Promise<void>((resolve) => this.waiters.push(resolve)); const event = this.queue.shift(); if (event) yield event; } }
}

class FakeProvider implements RealtimeSpeechProvider {
  readonly id = "fake";
  readonly session = new FakeSession();
  async connect(): Promise<RealtimeSpeechSession> { return this.session; }
  async capabilities(): Promise<RealtimeProviderCapabilities> {
    return { id: this.id, nativeAudio: true, inputTranscription: true, outputTranscription: true, interruption: true, inputFormats: [INPUT_FORMAT], outputFormat: { sampleRate: 24_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } };
  }
  async health(): Promise<{ status: "healthy"; providerId: string }> { return { status: "healthy", providerId: this.id }; }
}

function loudFrame(samples: number, value = 8000): Int16Array {
  return new Int16Array(samples).fill(value);
}

test("the provider is sent cleaned capture, not what the microphone heard", async () => {
  const provider = new FakeProvider();
  const core = { connect: () => provider.connect(), capabilities: async () => ({ providers: [await provider.capabilities()] }), health: () => provider.health() };
  const guard = new EchoGuard(SETTINGS, 16_000, 24_000, () => {});
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: INPUT_FORMAT }, () => {}, () => {}, undefined, undefined, guard);

  const session = await adapter.open();
  // The assistant starts speaking, then the microphone hears it come back.
  guard.playbackStarted();
  guard.pushPlayback(loudFrame(480));
  await adapter.sendMicrophonePcm(loudFrame(320));

  assert.equal(provider.session.receivedFrames.length, 1);
  assert.ok(provider.session.receivedFrames[0].data.every((sample) => sample === 0), "the assistant's own voice must not reach the provider");
  await session.close();
  await adapter.stop();
});

test("capabilities say whether cancellation is on and what it costs", async () => {
  const provider = new FakeProvider();
  const core = { connect: () => provider.connect(), capabilities: async () => ({ providers: [await provider.capabilities()] }), health: () => provider.health() };
  const guard = new EchoGuard({ ...SETTINGS, processor: "auto" }, 16_000, 24_000, () => {});
  const withGuard = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: INPUT_FORMAT }, () => {}, () => {}, undefined, undefined, guard);
  const without = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: INPUT_FORMAT });

  // Readable before a session exists, so a host can tell an assistant that will hear itself
  // from one that will not without having to start a conversation to find out.
  assert.deepEqual(await withGuard.capabilities().then((value) => value.echoCancellation), {
    processor: "auto",
    tailMs: 400,
    minErleDb: 6,
    preservesFullDuplex: true,
    recording: false,
  });
  assert.equal((await without.capabilities()).echoCancellation, null);
});

test("capture reaches the provider untouched when nothing is playing", async () => {
  const provider = new FakeProvider();
  const core = { connect: () => provider.connect(), capabilities: async () => ({ providers: [await provider.capabilities()] }), health: () => provider.health() };
  const guard = new EchoGuard(SETTINGS, 16_000, 24_000, () => {});
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: INPUT_FORMAT }, () => {}, () => {}, undefined, undefined, guard);

  const session = await adapter.open();
  const spoken = loudFrame(320, 4321);
  await adapter.sendMicrophonePcm(spoken);

  assert.deepEqual(provider.session.receivedFrames[0].data, spoken);
  await session.close();
  await adapter.stop();
});

test("the playback controller feeds the canceller exactly what the player is fed", () => {
  const written: Buffer[] = [];
  const seen: Int16Array[] = [];
  const reference = {
    playbackStarted: () => seen.push(new Int16Array(0)),
    pushPlayback: (data: Int16Array) => seen.push(data),
    playbackStopped: () => seen.push(new Int16Array(1)),
  };
  const controller = new PcmPlaybackController(() => ({ write: (chunk) => void written.push(chunk), end: () => {}, abort: () => {} }), reference);
  const chunk = loudFrame(480);

  controller.handle({ type: "output.audio_started", sessionId: "s", outputId: "o", timestampMs: 1 } as RealtimeSpeechEvent);
  controller.handle({ type: "output.audio_chunk", sessionId: "s", outputId: "o", timestampMs: 2, frame: { streamId: "o", timestampMs: 2, format: { sampleRate: 24_000, channels: 1, sampleFormat: "pcm_s16le" }, data: chunk } } as RealtimeSpeechEvent);
  controller.handle({ type: "output.interrupted", sessionId: "s", outputId: "o", timestampMs: 3 } as RealtimeSpeechEvent);

  assert.equal(written.length, 1, "the player still receives the audio");
  assert.equal(written[0].byteLength, chunk.byteLength);
  assert.deepEqual(seen[1], chunk, "the canceller receives the same samples the player did");
  assert.equal(seen[2].length, 1, "an interruption is reported so the schedule can be dropped");
});
