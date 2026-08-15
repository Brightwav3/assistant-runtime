/**
 * The host capability catalogue reaches the delegated model, and only the delegated model.
 *
 * With delegation on, the catalogue was previously installed into neither Tool System: the
 * voice registry deliberately skipped it, and nothing installed it anywhere else. The tools
 * existed in `host-tools` and were simply unreachable, which on hardware looked like a
 * speech or delegation failure — the assistant said it found no records of the time.
 *
 * The rule being asserted here is a boundary, not a preference. One policy surface decides
 * what may run. A second direct path from the voice model would be a second surface, and
 * the one nobody watches becomes the one that matters.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryRuntime, SqliteMemoryStore } from "memory-core";
import { createAssistantRuntime } from "../src/composition.js";
import { createDelegation } from "../src/delegation/composition.js";
import type { RuntimeSettings } from "../src/config.js";

const HOST_TOOLS = ["calculate", "get_time", "system_status", "uptime"];

const base = (path: string): RuntimeSettings => ({
  assistantId: "assistant.test",
  mode: "native_realtime",
  inactivityMs: 1000,
  activation: { provider: "double_clap", sourceId: "test-microphone", minimumIntervalMs: 100, maximumIntervalMs: 700, amplitudeThreshold: 0.1 },
  realtime: { provider: "gemini", inputSampleRate: 16000, outputSampleRate: 24000 },
  memory: { enabled: true, path, scopeSubjectId: "test-user" },
  state: { enabled: true },
  echoCancellation: { enabled: false, processor: "cancel_or_suppress", tailMs: 400, maxDelayMs: 1_000, suppressionGain: 0, bargeInMargin: 0, bargeInHoldMs: 800, minErleDb: 6, recoveryFrames: 25 },
  delegation: {
    enabled: true, provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [],
    deadlineMs: 45_000, maximumModelCalls: 6, maximumToolCalls: 12,
    cancelOnSessionClose: true, defaultDelivery: "when_idle", lateResultPolicy: "queue",
  },
  usage: { enabled: false, path: "", maxRecords: 100, unknownCostPolicy: "allow", priceCatalogVersion: "test" },
} as RuntimeSettings);

const microphone = async () => ({ on() {}, off() {}, stop() {} });

test("host tools are reachable through delegation and absent from the voice catalogue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegated-host-tools-"));
  const composition = await createAssistantRuntime(base(join(directory, "memory.sqlite")), undefined, { microphoneFactory: microphone });
  try {
    await composition.runtime.start();

    // The voice model keeps exactly one tool. Anything else here is a second path.
    const voice = composition.tools!.discover().map((declaration) => declaration.name).sort();
    assert.deepEqual(voice, ["intelligence_delegate"]);

    const component = composition.components.find((entry) => entry.id === "delegation");
    const capabilities = await component!.capabilities!() as { delegatedTools: string[] };
    for (const tool of HOST_TOOLS) {
      assert.ok(capabilities.delegatedTools.includes(tool), `${tool} must be reachable through delegation`);
    }
  } finally {
    await composition.runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("get_time runs through the delegated Tool System and returns an answer", async () => {
  // Registration is not capability. On hardware an unregistered tool and a registered but
  // broken one look identical — the assistant simply does not answer — so this executes it
  // through the very runtime the delegated model calls.
  const directory = await mkdtemp(join(tmpdir(), "delegated-get-time-"));
  const memory = new MemoryRuntime({ store: new SqliteMemoryStore({ path: join(directory, "memory.sqlite") }) });
  await memory.start();
  const delegation = createDelegation({
    delegation: base(join(directory, "memory.sqlite")).delegation!,
    usage: { enabled: false, path: "", maxRecords: 100, unknownCostPolicy: "allow", priceCatalogVersion: "test" },
    memory,
    hostTools: { uptime: { uptimeSeconds: () => 42 }, system: { snapshot: async () => ({ platform: "test", cpuLoad: 0.1, memoryUsedBytes: 1, memoryTotalBytes: 2 }) } } as never,
    subjectId: "test-user",
    correlation: () => ({ sessionId: "lsn_test" }),
  });
  try {
    await delegation.delegatedTools.start();
    const report = await delegation.delegatedTools.execute({ tool: "get_time", args: {}, requestId: "call-1" });

    assert.equal(report.outcome.kind, "result", "the clock answered");
    assert.match(report.outcome.kind === "result" ? report.outcome.content : "", /\d{4}-\d{2}-\d{2}/, "and answered with a date, not an apology");

    const arithmetic = await delegation.delegatedTools.execute({ tool: "calculate", args: { left: 2, operator: "add", right: 2 }, requestId: "call-2" });
    assert.equal(arithmetic.outcome.kind, "result");
    assert.match(arithmetic.outcome.kind === "result" ? arithmetic.outcome.content : "", /4/);
  } finally {
    await delegation.delegatedTools.stop();
    await memory.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("without delegation the voice model keeps the host catalogue it always had", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-host-tools-"));
  const settings = base(join(directory, "memory.sqlite"));
  const composition = await createAssistantRuntime(
    { ...settings, delegation: { ...settings.delegation!, enabled: false } },
    undefined,
    { microphoneFactory: microphone },
  );
  try {
    const voice = composition.tools!.discover().map((declaration) => declaration.name);
    for (const tool of HOST_TOOLS) assert.ok(voice.includes(tool), `${tool} belongs to the voice model when nothing else can run it`);
    assert.equal(voice.includes("intelligence_delegate"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
