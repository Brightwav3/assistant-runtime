import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantRuntime } from "../src/composition.js";
import type { RuntimeSettings } from "../src/config.js";
import { MemoryRuntime, SqliteMemoryStore } from "memory-core";

const settingsFor = (path: string): RuntimeSettings => ({
  assistantId: "assistant.test",
  mode: "native_realtime",
  inactivityMs: 1000,
  activation: { provider: "double_clap", sourceId: "test-microphone", minimumIntervalMs: 100, maximumIntervalMs: 700, amplitudeThreshold: 0.1 },
  realtime: { provider: "gemini", inputSampleRate: 16000, outputSampleRate: 24000 },
  memory: { enabled: true, path, scopeSubjectId: "test-user" },
  state: { enabled: true },
  echoCancellation: { enabled: false, processor: "auto" as const, tailMs: 400, maxDelayMs: 1_000, suppressionGain: 0, minErleDb: 6, recoveryFrames: 25 },
});

test("composition starts real memory/state components with an injected microphone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-runtime-"));
  const path = join(directory, "memory.sqlite");
  const microphone = { on() {}, off() {}, stop() {} };
  const composition = await createAssistantRuntime(settingsFor(path), undefined, { microphoneFactory: async () => microphone });
  try {
    await composition.runtime.start();
    assert.equal(composition.runtime.status().state, "running");
    assert.equal((await composition.memory!.health()).state, "healthy");
    assert.equal((await composition.state!.health()).state, "healthy");
    await composition.memory!.create({ kind: "preference", content: { type: "text", text: "The user prefers concise answers." }, scope: { type: "user", subjectId: "test-user" }, provenance: { sourceType: "user", sourceId: "test" }, confidence: 1 });
  } finally { await composition.runtime.stop(); }
  const restarted = new MemoryRuntime({ store: new SqliteMemoryStore({ path }) });
  await restarted.start();
  try { assert.equal((await restarted.list()).length, 1); } finally { await restarted.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("production composition registers safe host tools for realtime discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-runtime-tools-"));
  const composition = await createAssistantRuntime(settingsFor(join(directory, "memory.sqlite")), undefined, { microphoneFactory: async () => ({ on() {}, off() {}, stop() {} }) });
  try {
    const tools = composition.components.find((component) => component.id === "tools");
    assert.ok(tools, "production composition must host the realtime tools runtime");
    assert.deepEqual(await tools.capabilities!(), { tools: ["calculate", "end_conversation", "get_time", "system_status", "uptime"] });
    await composition.runtime.start();
    assert.equal((await composition.runtime.health()).components.tools?.state, "healthy");
  } finally {
    await composition.runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("modular mode exposes a real Scribe/Intelligence/Voice capability boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-runtime-modular-"));
  const composition = await createAssistantRuntime({ ...settingsFor(join(directory, "memory.sqlite")), mode: "modular" }, undefined, { microphoneFactory: async () => ({ on() {}, off() {}, stop() {} }) });
  try {
    assert.equal(composition.runtime.capabilities().modular, true);
    await composition.runtime.start();
    assert.equal((await composition.components.find((component) => component.id === "modular")!.health()).state, "healthy");
  } finally { await composition.runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});
