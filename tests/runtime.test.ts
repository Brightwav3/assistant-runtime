import assert from "node:assert/strict";
import test from "node:test";
import { AssistantRuntime } from "../src/runtime.js";
import { ActivationCoreAdapter, RealtimeCoreAdapter } from "../src/adapters.js";
import { ActivationRuntime, FakeActivationProvider } from "activation-core";
import { FakeRealtimeSpeechProvider, RealtimeCore } from "realtime-core";
import type { Activation, ActivationSource, ComponentHealth, RuntimeComponent } from "../src/contracts.js";

class Component implements RuntimeComponent { readonly events: string[] = []; constructor(readonly id: string, private readonly status: ComponentHealth = { state: "healthy" }) {} async start() { this.events.push("start"); } async stop() { this.events.push("stop"); } async health() { return this.status; } }
class ActivationFake extends Component implements ActivationSource { private handler?: (value: Activation) => void; subscribe(handler: (value: Activation) => void) { this.handler = handler; return () => { this.handler = undefined; }; } emit() { this.handler?.({ activationId: "a1", timestamp: new Date().toISOString() }); } }

test("starts deterministic components, aggregates health and reverses shutdown", async () => {
  const first = new Component("first"); const second = new Component("second", { state: "degraded" });
  const runtime = new AssistantRuntime({ assistantId: "assistant.primary", mode: "modular", inactivityMs: 1000 }, { components: [first, second] });
  await runtime.start(); assert.deepEqual((await runtime.health()).state, "degraded"); await runtime.stop(); assert.deepEqual(first.events, ["start", "stop"]); assert.deepEqual(second.events, ["start", "stop"]);
});
test("activation starts one modular interaction and stale completion cannot revive it", async () => {
  const activation = new ActivationFake("activation"); let complete!: () => void; const state: string[] = [];
  const runtime = new AssistantRuntime({ assistantId: "assistant.primary", mode: "modular", inactivityMs: 1000, state: { async set(value) { state.push(`${value.key}:${String(value.value)}`); } } }, { components: [activation], activation, modular: { async run() { await new Promise<void>((resolve) => { complete = resolve; }); } } });
  await runtime.start(); activation.emit(); activation.emit(); await new Promise((resolve) => setImmediate(resolve)); const id = runtime.status().interaction?.interactionId; assert.ok(id); await runtime.cancel(id); complete(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(runtime.status().interaction, null); assert.ok(state.includes("interaction.active:true")); assert.ok(state.includes("interaction.active:false")); await runtime.stop();
});
test("inactivity timeout cancels native interaction", async () => {
  const runtime = new AssistantRuntime({ assistantId: "assistant.primary", mode: "native_realtime", inactivityMs: 10 }, { components: [], nativeRealtime: { async open() { return { async close() {}, done: new Promise<void>(() => {}) }; } } });
  await runtime.start(); await runtime.activate(); await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(runtime.status().interaction, null); await runtime.stop();
});
test("uses published Activation and Realtime Core packages end to end", async () => {
  const provider = new FakeActivationProvider("external"); const activation = new ActivationCoreAdapter(new ActivationRuntime({ providers: [provider] }));
  const realtime = new RealtimeCoreAdapter(new RealtimeCore(new FakeRealtimeSpeechProvider()), { provider: "fake", inputFormat: { sampleRate: 16000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } });
  const runtime = new AssistantRuntime({ assistantId: "assistant.primary", mode: "native_realtime", inactivityMs: 1000 }, { components: [activation], activation, nativeRealtime: realtime });
  await runtime.start(); provider.detect({ method: "external" }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(runtime.status().interaction?.state, "active"); await runtime.cancel(); assert.equal(runtime.status().interaction, null); await runtime.stop();
});
