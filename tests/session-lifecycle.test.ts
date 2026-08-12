import assert from "node:assert/strict";
import test from "node:test";
import type { AudioFrame, RealtimeProviderCapabilities, RealtimeSessionConfig, RealtimeSpeechEvent, RealtimeSpeechProvider, RealtimeSpeechSession } from "realtime-core";
import { RealtimeCoreAdapter } from "../src/adapters.js";

class ProviderClosedSession implements RealtimeSpeechSession {
  readonly id = "provider-closed-session";
  private closed = false;
  private queue: RealtimeSpeechEvent[] = [{ type: "session.started", sessionId: this.id, providerId: "fake" }];
  private waiters: Array<() => void> = [];
  async sendAudio(_frame: AudioFrame): Promise<void> { if (this.closed) throw new Error("session closed"); }
  async sendText(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> { this.providerClose(); }
  providerClose(): void { if (this.closed) return; this.closed = true; this.queue.push({ type: "session.closed", sessionId: this.id }); for (const resolve of this.waiters.splice(0)) resolve(); }
  async *events(): AsyncIterable<RealtimeSpeechEvent> { while (!this.closed || this.queue.length) { if (!this.queue.length) await new Promise<void>((resolve) => this.waiters.push(resolve)); const event = this.queue.shift(); if (event) yield event; } }
}

class ProviderThatCloses implements RealtimeSpeechProvider {
  readonly id = "fake";
  readonly session = new ProviderClosedSession();
  async connect(_config: RealtimeSessionConfig): Promise<RealtimeSpeechSession> { return this.session; }
  async capabilities(): Promise<RealtimeProviderCapabilities> { return { id: this.id, nativeAudio: true, inputTranscription: true, outputTranscription: true, interruption: true, inputFormats: [{ sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 }], outputFormat: { sampleRate: 24000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }; }
  async health(): Promise<{ status: "healthy"; providerId: string }> { return { status: "healthy", providerId: this.id }; }
}

test("provider-closed realtime sessions stop accepting microphone frames without rejected input promises", async () => {
  const provider = new ProviderThatCloses();
  const core = { connect: (config: RealtimeSessionConfig) => provider.connect(config), capabilities: () => provider.capabilities(), health: () => provider.health() };
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } });
  await adapter.open();
  provider.session.providerClose();
  await assert.doesNotReject(() => adapter.sendMicrophonePcm(new Int16Array(320)));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.doesNotReject(() => adapter.sendMicrophonePcm(new Int16Array(320)));
});
