import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantRuntime } from "../src/composition.js";
import type { RuntimeSettings } from "../src/config.js";

const base = (path: string): RuntimeSettings => ({
  assistantId: "assistant.test",
  mode: "native_realtime",
  inactivityMs: 1000,
  activation: { provider: "double_clap", sourceId: "test-microphone", minimumIntervalMs: 100, maximumIntervalMs: 700, amplitudeThreshold: 0.1 },
  realtime: { provider: "gemini", inputSampleRate: 16000, outputSampleRate: 24000 },
  inputTranscription: { enabled: false, language: "cs" },
  memory: { enabled: true, path, scopeSubjectId: "test-user" },
  state: { enabled: true },
  echoCancellation: { enabled: false, processor: "cancel_or_suppress", tailMs: 400, maxDelayMs: 1_000, suppressionGain: 0, bargeInMargin: 0, bargeInHoldMs: 800, minErleDb: 6, recoveryFrames: 25 },
  delegation: {
    enabled: true, provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [],
    deadlineMs: 45_000, maximumModelCalls: 6, maximumToolCalls: 12,
    cancelOnSessionClose: true, defaultDelivery: "when_idle", lateResultPolicy: "queue",
  },
  usage: { enabled: false, path: "", maxRecords: 100, unknownCostPolicy: "allow", priceCatalogVersion: "test" },
});

const microphone = async () => ({ on() {}, off() {}, stop() {} });

test("enabling delegation swaps the voice catalogue instead of widening it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-delegation-"));
  const composition = await createAssistantRuntime(base(join(directory, "memory.sqlite")), undefined, { microphoneFactory: microphone });
  try {
    await composition.runtime.start();
    const voice = composition.tools!.discover().map((declaration) => declaration.name).sort();
    // The voice model gains delegation and loses the lookup tools it would otherwise use
    // to answer inline — which is the whole point, not a side effect.
    assert.deepEqual(voice, ["end_conversation", "intelligence_delegate"]);
    assert.equal(voice.includes("memory_search"), false);
    assert.equal(voice.includes("get_time"), false);

    const component = composition.components.find((entry) => entry.id === "delegation");
    assert.ok(component, "delegation runs as a lifecycle component");
    const capabilities = await component!.capabilities!() as { model: string; delegatedTools: string[] };
    assert.equal(capabilities.model, "gemini-2.5-flash");
    assert.deepEqual([...capabilities.delegatedTools].sort(), ["memory_search", "memory_view"]);
    assert.equal(capabilities.delegatedTools.includes("intelligence_delegate"), false);
  } finally {
    await composition.runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the voice model is told to delegate, not left with a tool it has no reason to call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-delegation-persona-"));
  const settings = base(join(directory, "memory.sqlite"));
  const composition = await createAssistantRuntime(settings, undefined, { microphoneFactory: microphone });
  try {
    await composition.runtime.start();
    const component = composition.components.find((entry) => entry.id === "delegation");
    assert.ok(component);
    assert.equal((await component!.health()).state, "healthy");
  } finally {
    await composition.runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("delegation stays off when memory is unavailable rather than answering blind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-delegation-nomemory-"));
  const settings = base(join(directory, "memory.sqlite"));
  const traces: Array<Record<string, unknown>> = [];
  const composition = await createAssistantRuntime(
    { ...settings, memory: { ...settings.memory, enabled: false } },
    (event) => traces.push(event),
    { microphoneFactory: microphone },
  );
  try {
    assert.equal(composition.components.some((entry) => entry.id === "delegation"), false);
    assert.ok(traces.some((event) => event.type === "delegation.disabled"));
    assert.equal(composition.tools!.discover().some((declaration) => declaration.name === "intelligence_delegate"), false);
    // Falling back to the ordinary catalogue is correct: no delegation, but still useful.
    assert.ok(composition.tools!.discover().some((declaration) => declaration.name === "get_time"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
