import assert from "node:assert/strict";
import test from "node:test";
import { AssistantRuntime } from "../src/runtime.js";
import { ActivationCoreAdapter, RealtimeCoreAdapter } from "../src/adapters.js";
import { ActivationRuntime, FakeActivationProvider } from "activation-core";
import { FakeRealtimeSpeechProvider, RealtimeCore } from "realtime-core";
import type { ComponentHealth, RuntimeComponent } from "../src/contracts.js";

class Component implements RuntimeComponent { readonly events: string[] = []; constructor(readonly id: string, private readonly status: ComponentHealth = { state: "healthy" }) {} async start() { this.events.push("start"); } async stop() { this.events.push("stop"); } async health() { return this.status; } }

test("starts deterministic components, aggregates health and reverses shutdown", async () => {
  const first = new Component("first"); const second = new Component("second", { state: "degraded" });
  const runtime = new AssistantRuntime({ assistantId: "assistant.primary", mode: "native_realtime", inactivityMs: 1000 }, { components: [first, second] });
  await runtime.start(); assert.deepEqual((await runtime.health()).state, "degraded"); await runtime.stop(); assert.deepEqual(first.events, ["start", "stop"]); assert.deepEqual(second.events, ["start", "stop"]);
});
test("inactivity timeout cancels native interaction", async () => {
  const runtime = new AssistantRuntime({ assistantId: "assistant.primary", mode: "native_realtime", inactivityMs: 10 }, { components: [], nativeRealtime: { async open() { return { async close() {}, done: new Promise<void>(() => {}) }; } } });
  await runtime.start(); await runtime.activate(); await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(runtime.status().interaction, null); await runtime.stop();
});

test("native activity resets the inactivity timeout", async () => {
  // Timed generously on purpose. At a 20 ms timeout with 10 ms sleeps this failed roughly
  // one run in twenty: under load a sleep overshoots, the interaction times out before the
  // activity call lands, and the failure looks like a defect in the runtime rather than in
  // the test's arithmetic. The margins here need a 100 ms overshoot to reproduce that.
  let activity!: () => void;
  const timeoutMs = 200;
  const runtime = new AssistantRuntime({ assistantId: "assistant.primary", mode: "native_realtime", inactivityMs: timeoutMs }, { components: [], nativeRealtime: { async open(input) { activity = (input as unknown as { onActivity?: () => void }).onActivity!; return { async close() {}, done: new Promise<void>(() => {}) }; } } });
  await runtime.start(); await runtime.activate();

  await new Promise((resolve) => setTimeout(resolve, timeoutMs / 2));
  assert.ok(runtime.status().interaction, "the interaction must still exist when activity is reported");
  activity();

  // Past the original deadline, but inside the one the activity call should have set.
  await new Promise((resolve) => setTimeout(resolve, timeoutMs * 0.75));
  assert.ok(runtime.status().interaction, "activity must have moved the deadline");
  await runtime.cancel(); await runtime.stop();
});
test("uses published Activation and Realtime Core packages end to end", async () => {
  const provider = new FakeActivationProvider("external"); const activation = new ActivationCoreAdapter(new ActivationRuntime({ providers: [provider] }));
  const realtime = new RealtimeCoreAdapter(new RealtimeCore(new FakeRealtimeSpeechProvider()), { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } });
  const runtime = new AssistantRuntime({ assistantId: "assistant.primary", mode: "native_realtime", inactivityMs: 1000 }, { components: [activation], activation, nativeRealtime: realtime });
  await runtime.start(); provider.detect({ method: "external" }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(runtime.status().interaction?.state, "active"); await runtime.cancel(); assert.equal(runtime.status().interaction, null); await runtime.stop();
});
