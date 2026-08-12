import assert from "node:assert/strict";
import test from "node:test";
import type { AudioFrame, RealtimeProviderCapabilities, RealtimeSessionConfig, RealtimeSpeechProvider, RealtimeSpeechEvent, RealtimeSpeechSession } from "realtime-core";
import { RealtimeCoreAdapter } from "../src/adapters.js";

class DelayedSession implements RealtimeSpeechSession {
  readonly id = "test-session";
  private closed = false;
  private eventsQueue: RealtimeSpeechEvent[] = [{ type: "session.started", sessionId: this.id, providerId: "fake" }];
  private waiters: Array<() => void> = [];
  async sendAudio(_frame: AudioFrame): Promise<void> { this.push({ type: "transcript.final", sessionId: this.id, text: "audio received", source: "input" }); }
  async sendText(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.push({ type: "session.closed", sessionId: this.id }); }
  async *events(): AsyncIterable<RealtimeSpeechEvent> { while (!this.closed || this.eventsQueue.length) { if (!this.eventsQueue.length) await new Promise<void>((resolve) => this.waiters.push(resolve)); const event = this.eventsQueue.shift(); if (event) yield event; } }
  private push(event: RealtimeSpeechEvent): void { this.eventsQueue.push(event); for (const resolve of this.waiters.splice(0)) resolve(); }
}

class DelayedProvider implements RealtimeSpeechProvider {
  readonly id = "fake";
  private readonly session = new DelayedSession();
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
