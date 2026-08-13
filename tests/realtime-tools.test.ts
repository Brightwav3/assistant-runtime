import assert from "node:assert/strict";
import test from "node:test";
import { FakeRealtimeSpeechProvider, RealtimeCore, type RealtimeProviderCapabilities, type RealtimeSessionConfig, type RealtimeSpeechEvent, type RealtimeSpeechProvider, type RealtimeSpeechSession, type RealtimeToolExecutor } from "realtime-core";
import { AllowlistPolicy, AllowlistProcessBroker, ToolRegistry, ToolRuntime, openAppDeclaration, openAppHandler, type BrokerLaunch } from "tool-system";
import { RealtimeCoreAdapter } from "../src/adapters.js";
import { ToolSystemRealtimeToolExecutor } from "../src/tool-bridge.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for realtime tool execution.");
}

function calculatorRuntime() {
  const launched: BrokerLaunch[] = [];
  const registry = new ToolRegistry();
  registry.register(openAppDeclaration({ calculator: "calc.exe" }), openAppHandler({ calculator: "calc.exe" }));
  const runtime = new ToolRuntime({
    registry,
    policy: new AllowlistPolicy({ allow: ["open_app"] }),
    services: { process: new AllowlistProcessBroker({ executables: ["calc.exe"], spawn: async (launch) => { launched.push(launch); } }) },
  });
  return { runtime, launched };
}

test("adapter discovers Tool System declarations and returns the tool result to a fake realtime provider", async () => {
  const provider = new FakeRealtimeSpeechProvider({ toolCall: { tool: "open_app", arguments: { app: "calculator" } } });
  let connectedConfig: RealtimeSessionConfig | undefined;
  const core = {
    connect: async (config: RealtimeSessionConfig) => { connectedConfig = config; return provider.connect(config); },
    capabilities: () => provider.capabilities(),
    health: () => provider.health(),
  };
  const { runtime, launched } = calculatorRuntime();
  await runtime.start();
  const traces: Record<string, unknown>[] = [];
  const executor = new ToolSystemRealtimeToolExecutor(runtime);
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }, (event) => traces.push(event), undefined, executor);
  const opened = await adapter.open();

  await waitFor(() => provider.toolResults.length === 1);
  await waitFor(() => traces.some((event) => event.type === "realtime.playback.metrics"));
  assert.equal(connectedConfig?.tools?.[0]?.name, "open_app");
  assert.deepEqual(provider.toolResults[0], { callId: provider.toolResults[0]?.callId, content: "Opened calculator." });
  assert.deepEqual(launched, [{ executable: "calc.exe", args: [] }]);
  assert.ok(traces.some((event) => event.type === "realtime.tool.metrics" && event.completed === 1));
  assert.ok(traces.some((event) => event.type === "realtime.playback.metrics" && event.bytesWritten === 960));
  assert.ok(traces.every((event) => !("arguments" in event)));
  await opened.close();
});

test("adapter sends an error result when the injected executor fails", async () => {
  const provider = new FakeRealtimeSpeechProvider({ toolCall: { tool: "open_app", arguments: { app: "calculator" } } });
  const core = { connect: (config: RealtimeSessionConfig) => provider.connect(config), capabilities: () => provider.capabilities(), health: () => provider.health() };
  const executor: RealtimeToolExecutor = {
    async discover() { return []; },
    async execute() { throw new Error("executor failure"); },
  };
  const traces: Record<string, unknown>[] = [];
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }, (event) => traces.push(event), undefined, executor);
  const opened = await adapter.open();
  await waitFor(() => provider.toolResults.length === 1);
  assert.equal(provider.toolResults[0]?.isError, true);
  assert.equal(provider.toolResults[0]?.content, "Realtime tool execution failed: executor failure");
  assert.ok(traces.some((event) => event.type === "realtime.tool.metrics" && event.failed === 1));
  await opened.close();
});

class ClosingToolSession implements RealtimeSpeechSession {
  readonly id = "closing-tool-session";
  readonly results: unknown[] = [];
  private closed = false;
  private queue: RealtimeSpeechEvent[] = [{ type: "session.started", sessionId: this.id, providerId: "fake", timestampMs: Date.now() }];
  private waiters: Array<() => void> = [];
  async sendAudio(): Promise<void> {}
  async sendText(): Promise<void> { this.queue.push({ type: "tool.requested", sessionId: this.id, callId: "call-closed", tool: "open_app", arguments: { app: "calculator" }, timestampMs: Date.now() }); for (const resolve of this.waiters.splice(0)) resolve(); }
  async sendToolResult(result: unknown): Promise<void> { this.results.push(result); }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.queue.push({ type: "session.closed", sessionId: this.id, timestampMs: Date.now() }); for (const resolve of this.waiters.splice(0)) resolve(); }
  async *events(): AsyncIterable<RealtimeSpeechEvent> { while (!this.closed || this.queue.length) { if (!this.queue.length) await new Promise<void>((resolve) => this.waiters.push(resolve)); const event = this.queue.shift(); if (event) yield event; } }
}

class ClosingToolProvider implements RealtimeSpeechProvider {
  readonly id = "fake";
  readonly session = new ClosingToolSession();
  async connect(_config: RealtimeSessionConfig): Promise<RealtimeSpeechSession> { return this.session; }
  async capabilities(): Promise<RealtimeProviderCapabilities> { return { id: this.id, nativeAudio: true, inputTranscription: true, outputTranscription: true, interruption: true, inputFormats: [{ sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 }], outputFormat: { sampleRate: 24_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }; }
  async health(): Promise<{ status: "healthy"; providerId: string }> { return { status: "healthy", providerId: this.id }; }
}

test("adapter does not send a late tool result after the realtime session closes", async () => {
  const provider = new ClosingToolProvider();
  const core = { connect: (config: RealtimeSessionConfig) => provider.connect(config), capabilities: () => provider.capabilities(), health: () => provider.health() };
  let release: (() => void) | undefined;
  const executor: RealtimeToolExecutor = {
    async discover() { return []; },
    async execute() { await new Promise<void>((resolve) => { release = resolve; }); return { content: "late result" }; },
  };
  const adapter = new RealtimeCoreAdapter(core as never, { provider: "fake", inputFormat: { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }, undefined, undefined, executor);
  const opened = await adapter.open();
  await new Promise((resolve) => setImmediate(resolve));
  await opened.close();
  release?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(provider.session.results, []);
});
