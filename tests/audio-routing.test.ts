import assert from "node:assert/strict";
import test from "node:test";
import type { AudioFrame, RealtimeProviderCapabilities, RealtimeSessionConfig, RealtimeSpeechProvider, RealtimeSpeechEvent, RealtimeSpeechSession } from "realtime-core";
import { RealtimeCoreAdapter } from "../src/adapters.js";

class DelayedSession implements RealtimeSpeechSession {
  readonly id = "test-session";
  private closed = false;
  readonly receivedFrames: AudioFrame[] = [];
  private eventsQueue: RealtimeSpeechEvent[] = [{ type: "session.started", sessionId: this.id, providerId: "fake", timestampMs: Date.now() }];
  private waiters: Array<() => void> = [];
  async sendAudio(frame: AudioFrame): Promise<void> { this.receivedFrames.push({ ...frame, data: frame.data.slice() }); this.push({ type: "transcript.final", sessionId: this.id, text: "audio received", source: "input", timestampMs: Date.now() }); }
  async sendText(): Promise<void> {}
  async sendToolResult(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.push({ type: "session.closed", sessionId: this.id, timestampMs: Date.now() }); }
  async *events(): AsyncIterable<RealtimeSpeechEvent> { while (!this.closed || this.eventsQueue.length) { if (!this.eventsQueue.length) await new Promise<void>((resolve) => this.waiters.push(resolve)); const event = this.eventsQueue.shift(); if (event) yield event; } }
  private push(event: RealtimeSpeechEvent): void { this.eventsQueue.push(event); for (const resolve of this.waiters.splice(0)) resolve(); }
}

class DelayedProvider implements RealtimeSpeechProvider {
  readonly id = "fake";
  readonly session = new DelayedSession();
  private releaseConnect?: () => void;
  async connect(_config: RealtimeSessionConfig): Promise<RealtimeSpeechSession> { await new Promise<void>((resolve) => { this.releaseConnect = resolve; }); return this.session; }
  release(): void { this.releaseConnect?.(); }
  async capabilities(): Promise<RealtimeProviderCapabilities> { return { id: this.id, nativeAudio: true, inputTranscription: true, outputTranscription: true, interruption: true, inputFormats: [{ sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 }], outputFormat: { sampleRate: 24000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }; }
  async health(): Promise<{ status: "healthy"; providerId: string }> { return { status: "healthy", providerId: this.id }; }
}

test("microphone PCM arriving during connect is flushed into the active session", async () => {
  const provider = new DelayedProvider(); const events: Record<string, unknown>[] = []; const speechEvents: RealtimeSpeechEvent[] = [];
  const core = { connect: (config: RealtimeSessionConfig) => provider.connect(config), capabilities: () => provider.capabilities(), health: () => provider.health() };
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }, (event) => events.push(event), (event) => speechEvents.push(event));
  const opening = adapter.open();
  await adapter.sendMicrophonePcm(new Int16Array(320));
  provider.release();
  const session = await opening;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "realtime.transcript.final" && event.source === "input"));
  assert.ok(speechEvents.some((event) => event.type === "transcript.final" && event.sessionId === "test-session"));
  await session.close();
});

test("a 100 ms capture chunk is sent as five 20 ms realtime frames", async () => {
  const provider = new DelayedProvider();
  const core = { connect: (config: RealtimeSessionConfig) => provider.connect(config), capabilities: () => provider.capabilities(), health: () => provider.health() };
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } });
  const opening = adapter.open();
  await adapter.sendMicrophonePcm(new Int16Array(1600).fill(11));
  provider.release();
  const session = await opening;
  assert.equal(provider.session.receivedFrames.length, 5);
  assert.deepEqual(provider.session.receivedFrames.map((frame) => frame.data.length), [320, 320, 320, 320, 320]);
  assert.ok(provider.session.receivedFrames.every((frame) => frame.format.frameDurationMs === 20));
  await session.close();
});

test("the local input-transcription hook receives a continuous 20 ms audio timeline", async () => {
  const provider = new DelayedProvider();
  const frames: AudioFrame[] = [];
  const core = { connect: (config: RealtimeSessionConfig) => provider.connect(config), capabilities: () => provider.capabilities(), health: () => provider.health() };
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }, undefined, undefined, undefined, undefined, undefined, (frame) => frames.push(frame));
  const opening = adapter.open();
  provider.release();
  const session = await opening;
  await adapter.sendMicrophonePcm(new Int16Array(1600).fill(11));
  assert.equal(frames.length, 5);
  assert.deepEqual(frames.map((frame, index) => frame.timestampMs - frames[0]!.timestampMs), [0, 20, 40, 60, 80]);
  await session.close();
});

test("pending input keeps only the newest 500 ms and reports dropped frames", async () => {
  const provider = new DelayedProvider();
  const events: Record<string, unknown>[] = [];
  const core = { connect: (config: RealtimeSessionConfig) => provider.connect(config), capabilities: () => provider.capabilities(), health: () => provider.health() };
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }, (event) => events.push(event));
  const opening = adapter.open();
  for (let index = 0; index < 30; index += 1) await adapter.sendMicrophonePcm(new Int16Array(320).fill(index));
  provider.release();
  const session = await opening;
  assert.equal(provider.session.receivedFrames.length, 25);
  assert.deepEqual(provider.session.receivedFrames[0]?.data[0], 5);
  assert.deepEqual(provider.session.receivedFrames.at(-1)?.data[0], 29);
  assert.ok(events.some((event) => event.type === "realtime.input.metrics" && event.framesDropped === 5 && event.bufferedMs === 500));
  await session.close();
});

class FlushSession extends DelayedSession {
  endAudioStreamCalls = 0;
  override async endAudioStream(): Promise<void> { this.endAudioStreamCalls += 1; }
}

test("a paused microphone flushes the provider's held audio instead of stranding it", async () => {
  // Break caught: the provider buffers captured audio until silence or an explicit
  // end-of-stream. A microphone that stops mid-utterance left that audio unprocessed.
  const session = new FlushSession();
  const core = { connect: async () => session, capabilities: async () => ({}), health: async () => ({ status: "healthy", providerId: "fake" }) };
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } });
  const handle = await adapter.open();
  await adapter.sendMicrophonePcm(new Int16Array(320));
  assert.equal(session.endAudioStreamCalls, 0, "a still-streaming microphone must not be flushed");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(session.endAudioStreamCalls, 1);
  await handle.close();
});

test("closing the session cancels the pending capture flush", async () => {
  const session = new FlushSession();
  const core = { connect: async () => session, capabilities: async () => ({}), health: async () => ({ status: "healthy", providerId: "fake" }) };
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } });
  const handle = await adapter.open();
  await adapter.sendMicrophonePcm(new Int16Array(320));
  await handle.close();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(session.endAudioStreamCalls, 0, "a closed session must not receive a late end-of-stream");
});
