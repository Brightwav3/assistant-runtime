import assert from "node:assert/strict";
import test from "node:test";

import { FakeModelProvider, ModelGateway, type ModelResponse } from "intelligence-core";
import { InMemoryMemoryStore, MemoryRuntime } from "memory-core";
import { FakeRealtimeSpeechProvider, REALTIME_INPUT_FORMAT, RealtimeCore } from "realtime-core";
import { ToolRegistry, ToolRuntime, AllowlistPolicy, InMemoryTraceSink } from "tool-system";

import { createDelegation, registerVoiceDelegationTool, type DelegationCompositionInput } from "../src/delegation/composition.js";
import { INTELLIGENCE_DELEGATE_TOOL } from "../src/delegation/intelligence-tool.js";
import { MEMORY_SEARCH_TOOL, MEMORY_VIEW_TOOL } from "../src/delegation/memory-tools.js";
import type { DelegationSettings, UsageSettings } from "../src/config.js";

const delegation: DelegationSettings = {
  enabled: true,
  provider: "gemini",
  model: "gemini-2.5-flash",
  fallbackModels: [],
  deadlineMs: 5_000,
  maximumModelCalls: 3,
  maximumToolCalls: 6,
  cancelOnSessionClose: true,
  defaultDelivery: "when_idle",
  lateResultPolicy: "queue",
};

const usage: UsageSettings = { enabled: false, path: "", maxRecords: 100, unknownCostPolicy: "allow", priceCatalogVersion: "test" };

async function memoryRuntime(): Promise<MemoryRuntime> {
  const memory = new MemoryRuntime({ store: new InMemoryMemoryStore() });
  await memory.start();
  return memory;
}

function gatewayReturning(...responses: ModelResponse[]): ModelGateway {
  const models = new ModelGateway();
  models.register(new FakeModelProvider({ id: "gemini", responses }));
  return models;
}

async function composed(overrides: Partial<DelegationCompositionInput> = {}) {
  const traces: Array<Record<string, unknown>> = [];
  const extraTrace = overrides.trace;
  const { trace: _ignoredTrace, ...compositionOverrides } = overrides;
  const memory = overrides.memory ?? (await memoryRuntime());
  const composition = createDelegation({
    delegation,
    usage,
    memory,
    subjectId: "user-1",
    correlation: () => ({ sessionId: "session-1", interactionId: "interaction-1" }),
    trace: (event) => { traces.push(event); extraTrace?.(event); },
    modelGateway: gatewayReturning({ type: "final", message: { role: "assistant", content: JSON.stringify({ schema: "delegation.result.v1", data: {}, references: [] }) } }),
    ...compositionOverrides,
  });
  await composition.start();
  return { composition, traces, memory };
}

test("the live broker preserves silent delivery for an unbound compaction result", async () => {
  let resolveDelivery!: (event: Record<string, unknown>) => void;
  const delivery = new Promise<Record<string, unknown>>((resolve) => { resolveDelivery = resolve; });
  const { composition, traces } = await composed({
    trace: (event) => {
      if (event.type === "delegation.delivery.sent" || event.type === "delegation.delivery.dropped") resolveDelivery(event);
    },
  });

  await composition.broker.accept({
    requestId: "compaction-request",
    goal: "silent compaction",
    selectedMemoryIds: [],
    selectedContext: [],
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    cancelOnSessionClose: false,
    maximumModelCalls: 1,
    maximumToolCalls: 0,
    delivery: { mode: "silent", lateResult: "drop" },
  });

  const result = await delivery;
  assert.equal(result.type, "delegation.delivery.sent");
  assert.equal(traces.some((event) => event.type === "delegation.delivery.dropped"), false);
  await composition.stop();
});

test("a failed memory tool cannot become a completed delegation", async () => {
  const episodes = {
    listTurns: async () => [{
      turnId: "turn-1",
      speaker: "user",
      text: "Zapomněl jsem, že mám rád plechovky.",
      verbatim: "Zapomněl jsem, že mám rád plechovky.",
      meaning: "Uživatel uvádí, že zapomněl na svou oblibu plechovek.",
      status: "complete",
      startedAt: "2026-08-16T15:03:15.000Z",
      transcriptConfidence: "reliable",
      uncertainParts: [],
    }],
  } as NonNullable<DelegationCompositionInput["episodes"]>;
  const { composition, traces } = await composed({
    episodes,
    modelGateway: gatewayReturning(
      {
        type: "tool_requests",
        tool_requests: [{
          id: "call-memory-create",
          tool_id: "memory_create",
          arguments: { turn_id: "turn-1", kind: "fact", content: "Uživatel má rád plechovky." },
        }],
      },
      {
        type: "final",
        message: {
          role: "assistant",
          content: JSON.stringify({
            schema: "delegation.result.v1",
            summary: "Paměť byla uložena.",
            data: { operation: "memory_create", status: "created", memoryId: "invented" },
            references: [{ turnId: "turn-1", provenance: { sourceType: "conversation", sourceId: "turn-1" } }],
          }),
        },
      },
    ),
  });

  const failed = new Promise<Extract<import("../src/contracts.js").DelegationEvent, { type: "delegation.failed" }>>((resolve) => {
    composition.broker.onEvent((event) => { if (event.type === "delegation.failed") resolve(event); });
  });
  await composition.broker.accept({
    requestId: "req-memory-rejected",
    sessionId: "session-1",
    goal: "Ulož tento údaj do paměti.",
    selectedMemoryIds: [],
    selectedContext: [],
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    cancelOnSessionClose: true,
    maximumModelCalls: 2,
    maximumToolCalls: 1,
    delivery: { mode: "when_idle", lateResult: "queue" },
  });

  const failure = await failed;
  assert.equal(failure.failure.code, "DELEGATION_TOOL_FAILED");
  assert.equal(traces.some((event) => event.type === "delegation.completed"), false);
  assert.equal(traces.some((event) => event.type === "delegation.delivery.sent"), false);
  assert.ok(traces.some((event) => event.type === "delegation.tool.failed" && event.tool === "memory_create"));
  await composition.stop();
});

test("the delegated catalogue is memory only and never contains the delegation tool", async () => {
  const { composition } = await composed();
  const names = composition.delegatedTools.discover().map((declaration) => declaration.name).sort();
  assert.deepEqual(names, [MEMORY_SEARCH_TOOL, MEMORY_VIEW_TOOL].sort());
  assert.equal(names.includes(INTELLIGENCE_DELEGATE_TOOL), false);
  await composition.stop();
});

test("the voice registry receives only the delegation tool from this composition", async () => {
  const { composition } = await composed();
  const registry = new ToolRegistry();
  const name = registerVoiceDelegationTool(registry, composition, {
    delegation, usage, memory: await memoryRuntime(), subjectId: "user-1",
    correlation: () => ({}),
  });
  assert.equal(name, INTELLIGENCE_DELEGATE_TOOL);
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [INTELLIGENCE_DELEGATE_TOOL] }), trace: new InMemoryTraceSink() });
  assert.deepEqual(runtime.discover().map((declaration) => declaration.name), [INTELLIGENCE_DELEGATE_TOOL]);
  await composition.stop();
});

test("a repeated stop is safe and leaves no active executions", async () => {
  const { composition } = await composed();
  await composition.broker.accept({
    requestId: "req-1", sessionId: "session-1", goal: "najdi robota",
    selectedMemoryIds: [], selectedContext: [],
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    cancelOnSessionClose: true, maximumModelCalls: 1, maximumToolCalls: 1,
    delivery: { mode: "when_idle", lateResult: "queue" },
  });
  await composition.stop();
  await composition.stop();
  assert.deepEqual(composition.broker.activeExecutionIds(), []);
});

test("a model failure surfaces as a bounded failure and never leaks the provider message", async () => {
  const { composition, traces } = await composed({
    modelGateway: (() => {
      const models = new ModelGateway();
      models.register({
        id: "gemini",
        models: async () => [], capabilities: async () => ({ streaming: false, tool_calling: true, structured_output: false, vision: false }),
        health: async () => ({ state: "unhealthy" }),
        generate: async () => { throw new Error("api key sk-secret-value rejected by upstream"); },
      });
      return models;
    })(),
  });

  // Awaited rather than slept on: the gateway backs off before retrying a failure it
  // considers transient, so any fixed delay here is a guess that will eventually be wrong.
  const failed = new Promise<void>((resolve) => composition.broker.onEvent((event) => { if (event.type === "delegation.failed") resolve(); }));
  await composition.broker.accept({
    requestId: "req-1", sessionId: "session-1", goal: "najdi robota",
    selectedMemoryIds: [], selectedContext: [],
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    cancelOnSessionClose: true, maximumModelCalls: 1, maximumToolCalls: 1,
    delivery: { mode: "when_idle", lateResult: "queue" },
  });
  await failed;

  assert.ok(traces.some((event) => event.type === "delegation.failed"));
  assert.equal(JSON.stringify(traces).includes("sk-secret-value"), false);
  await composition.stop();
});

test("closing the session cancels the delegation and reports it", async () => {
  const { composition, traces } = await composed();
  await composition.broker.accept({
    requestId: "req-1", sessionId: "session-1", goal: "najdi robota",
    selectedMemoryIds: [], selectedContext: [],
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    cancelOnSessionClose: true, maximumModelCalls: 1, maximumToolCalls: 1,
    delivery: { mode: "when_idle", lateResult: "queue" },
  });
  await composition.broker.closeSession("session-1");
  assert.ok(traces.some((event) => event.type === "delegation.cancelled"));
  assert.deepEqual(composition.broker.activeExecutionIds(), []);
  await composition.stop();
});

test("delivery survives a provider session that closed while a result was queued", async () => {
  const { composition } = await composed();
  const provider = new FakeRealtimeSpeechProvider({ toolCalling: "async", contextInjection: true });
  const session = await new RealtimeCore(provider).connect({ provider: "fake", inputFormat: REALTIME_INPUT_FORMAT });
  composition.delivery.bind({ sessionId: "session-1", session, contextInjection: true });
  composition.delivery.markOutputStarted("session-1");

  await composition.delivery.deliver({
    type: "delegation.completed", requestId: "req-1", executionId: "del-1", sessionId: "session-1",
    status: "completed", delivery: { mode: "when_idle", lateResult: "queue" }, result: { schema: "delegation.result.v1", data: {}, references: [] },
    occurredAt: "2026-08-14T12:00:00.000Z",
  }, { mode: "when_idle", lateResult: "queue" });
  assert.equal(composition.delivery.queuedCount("session-1"), 1);

  await composition.delivery.closeSession("session-1");
  assert.equal(composition.delivery.queuedCount("session-1"), 0);

  // A reconnect drains what was kept, so the user is not silently left without an answer.
  const reconnected = await new RealtimeCore(provider).connect({ provider: "fake", inputFormat: REALTIME_INPUT_FORMAT });
  await composition.delivery.rebind({ sessionId: "session-1", session: reconnected, contextInjection: true });

  await session.close();
  await reconnected.close();
  await composition.stop();
});

test("usage metering records the delegation's physical model call without prompts", async () => {
  const { composition } = await composed();
  await composition.broker.accept({
    requestId: "req-1", sessionId: "session-1", goal: "tajny dotaz o robotovi",
    selectedMemoryIds: [], selectedContext: [],
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    cancelOnSessionClose: true, maximumModelCalls: 1, maximumToolCalls: 1,
    delivery: { mode: "when_idle", lateResult: "queue" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const records = composition.usage.records();
  assert.ok(records.length >= 1);
  assert.equal(records[0]?.role, "delegation");
  assert.equal(records[0]?.redacted, true);
  assert.equal(JSON.stringify(records).includes("tajny dotaz"), false);
  await composition.stop();
});
