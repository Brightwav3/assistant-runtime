import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryMemoryStore, MemoryRuntime, type CreateMemoryInput } from "memory-core";
import { AllowlistPolicy, InMemoryTraceSink, ToolRegistry, ToolRuntime } from "tool-system";

import {
  MEMORY_SEARCH_TOOL,
  MEMORY_VIEW_TOOL,
  memorySearchDeclaration,
  memorySearchHandler,
  memoryViewDeclaration,
  memoryViewHandler,
} from "../src/delegation/memory-tools.js";
import {
  INTELLIGENCE_DELEGATE_TOOL,
  intelligenceDelegateDeclaration,
  intelligenceDelegateHandler,
} from "../src/delegation/intelligence-tool.js";
import { ToolSystemRealtimeToolExecutor, ToolSystemToolClient } from "../src/tool-bridge.js";
import type { DelegationAccepted, DelegationBroker, DelegationRequest } from "../src/contracts.js";

const SUBJECT = "user-1";
const CURRENT_TURN = { current_verbatim: "Aktuální věta.", current_meaning: "Aktuální věta.", current_language: "cs", current_uncertain_parts: "[]" } as const;

const fact = (text: string, subjectId = SUBJECT, extra: Partial<CreateMemoryInput> = {}): CreateMemoryInput => ({
  kind: "fact",
  content: { type: "text", text },
  scope: { type: "user", subjectId },
  provenance: { sourceType: "user" },
  confidence: 0.9,
  ...extra,
});

async function seededMemory() {
  const ids = ["robot-mit", "robot-mars", "submarine-project"];
  let extra = 0;
  const memory = new MemoryRuntime({ store: new InMemoryMemoryStore(), idFactory: () => ids.shift() ?? `memory-${++extra}` });
  await memory.start();
  await memory.create(fact("novy robot z MIT pro laboratorni praci"));
  await memory.create(fact("novy robot pro Mars misi"));
  await memory.create(fact("projekt s ponorkou a robotem"));
  return memory;
}

class RecordingBroker implements DelegationBroker {
  public readonly accepted: Array<Omit<DelegationRequest, "executionId">> = [];
  public async accept(input: Omit<DelegationRequest, "executionId">): Promise<DelegationAccepted> {
    this.accepted.push(input);
    return {
      requestId: input.requestId,
      executionId: "del-1",
      status: "accepted",
      assistantInstruction: { type: "acknowledge-background-work", text: "Acknowledge briefly.", doNotInventResult: true },
    };
  }
  public async cancel(): Promise<void> {}
  public onEvent(): () => void { return () => undefined; }
  public async closeSession(): Promise<void> {}
}

async function delegatedToolSystem(memory: MemoryRuntime, allow: string[] = [MEMORY_SEARCH_TOOL, MEMORY_VIEW_TOOL]) {
  const registry = new ToolRegistry();
  registry.register(memorySearchDeclaration(), memorySearchHandler({ memory, subjectId: SUBJECT }));
  registry.register(memoryViewDeclaration(), memoryViewHandler({ memory, subjectId: SUBJECT }));
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow }), trace: new InMemoryTraceSink() });
  await runtime.start();
  return runtime;
}

async function voiceToolSystem(broker: DelegationBroker, capture?: (input: { verbatim: string; meaning: string; language: string; uncertainParts: unknown[]; heardId: string }) => Promise<void>) {
  const registry = new ToolRegistry();
  registry.register(intelligenceDelegateDeclaration(), intelligenceDelegateHandler({
    broker,
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    correlation: () => ({ sessionId: "session-1", interactionId: "interaction-1" }),
    captureCurrentTurn: capture,
    selectedContext: async () => [{ sourceId: "turn-7", text: "user: Mám rád malé motorky", kind: "episode" }],
    deadlineMs: 30_000,
    maximumModelCalls: 4,
    maximumToolCalls: 8,
    cancelOnSessionClose: true,
    defaultDelivery: { mode: "when_idle", lateResult: "queue" },
    clock: () => 1_800_000_000_000,
  }));
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [INTELLIGENCE_DELEGATE_TOOL] }), trace: new InMemoryTraceSink() });
  await runtime.start();
  return runtime;
}

test("memory_search returns bounded evidence with IDs, scores, reasons, and provenance", async () => {
  const memory = await seededMemory();
  const runtime = await delegatedToolSystem(memory);
  const report = await runtime.execute({ tool: MEMORY_SEARCH_TOOL, args: { query: "novy robot" }, requestId: "call-1" });
  assert.equal(report.outcome.kind, "result");
  if (report.outcome.kind !== "result") throw new Error("expected a result");
  assert.match(report.outcome.content, /id=robot-mit/);
  assert.match(report.outcome.content, /score=/);
  assert.match(report.outcome.content, /confidence=/);
  assert.match(report.outcome.content, /source=user/);
  // Remembered content is data the model reads, not instructions it obeys.
  assert.equal(report.outcome.taint, "external");
});

test("memory_search cannot reach another subject's memories", async () => {
  const memory = await seededMemory();
  await memory.create(fact("novy robot jineho uzivatele", "user-2"));
  const runtime = await delegatedToolSystem(memory);
  const report = await runtime.execute({ tool: MEMORY_SEARCH_TOOL, args: { query: "robot" }, requestId: "call-1" });
  assert.equal(report.outcome.kind === "result" && report.outcome.content.includes("jineho uzivatele"), false);
});

test("memory_search excludes forgotten records", async () => {
  const memory = await seededMemory();
  const forgotten = await memory.create(fact("zapomenuty robot z Marsu"));
  await memory.forget(forgotten.memoryId);
  const runtime = await delegatedToolSystem(memory);
  const report = await runtime.execute({ tool: MEMORY_SEARCH_TOOL, args: { query: "zapomenuty" }, requestId: "call-1" });
  assert.equal(report.outcome.kind === "result" && report.outcome.content, "No matching memories.");
});

test("Tool System rejects arguments outside the declared bounds", async () => {
  const memory = await seededMemory();
  const runtime = await delegatedToolSystem(memory);
  const tooLong = await runtime.execute({ tool: MEMORY_SEARCH_TOOL, args: { query: "x".repeat(500) }, requestId: "call-1" });
  assert.equal(tooLong.outcome.kind, "error");
  const tooMany = await runtime.execute({ tool: MEMORY_SEARCH_TOOL, args: { query: "robot", limit: 99 }, requestId: "call-2" });
  assert.equal(tooMany.outcome.kind, "error");
  const missing = await runtime.execute({ tool: MEMORY_SEARCH_TOOL, args: {}, requestId: "call-3" });
  assert.equal(missing.outcome.kind, "error");
});

test("policy denial is refused by Tool System, not worked around by the handler", async () => {
  const memory = await seededMemory();
  const runtime = await delegatedToolSystem(memory, [MEMORY_VIEW_TOOL]);
  const report = await runtime.execute({ tool: MEMORY_SEARCH_TOOL, args: { query: "robot" }, requestId: "call-1" });
  assert.equal(report.outcome.kind, "error");
});

test("memory_view reads exactly one record and never lists neighbours", async () => {
  const memory = await seededMemory();
  const runtime = await delegatedToolSystem(memory);
  const report = await runtime.execute({ tool: MEMORY_VIEW_TOOL, args: { memory_id: "robot-mit", before: 1, after: 1 }, requestId: "call-1" });
  assert.equal(report.outcome.kind, "result");
  if (report.outcome.kind !== "result") throw new Error("expected a result");
  assert.match(report.outcome.content, /id=robot-mit/);
  assert.match(report.outcome.content, /MIT/);
  assert.equal(report.outcome.content.includes("Mars"), false);
  assert.equal(report.outcome.content.includes("ponorkou"), false);
});

test("memory_view answers an unknown and an unreadable ID identically", async () => {
  const memory = await seededMemory();
  const forgotten = await memory.create(fact("zapomenuty zaznam"));
  await memory.forget(forgotten.memoryId);
  const runtime = await delegatedToolSystem(memory);
  const unknown = await runtime.execute({ tool: MEMORY_VIEW_TOOL, args: { memory_id: "does-not-exist" }, requestId: "call-1" });
  const hidden = await runtime.execute({ tool: MEMORY_VIEW_TOOL, args: { memory_id: forgotten.memoryId }, requestId: "call-2" });
  assert.equal(unknown.outcome.kind === "result" && unknown.outcome.content, "No readable memory has that ID.");
  assert.equal(hidden.outcome.kind === "result" && hidden.outcome.content, "No readable memory has that ID.");
});

test("cancellation reaches Memory Core through the tool context signal", async () => {
  const memory = await seededMemory();
  const runtime = await delegatedToolSystem(memory);
  const controller = new AbortController();
  controller.abort();
  const report = await runtime.execute({ tool: MEMORY_SEARCH_TOOL, args: { query: "robot" }, requestId: "call-1" }, controller.signal);
  assert.equal(report.outcome.kind, "error");
});

test("intelligence_delegate returns a continuation immediately and does not await a result", async () => {
  const broker = new RecordingBroker();
  const runtime = await voiceToolSystem(broker);
  const report = await runtime.execute({ tool: INTELLIGENCE_DELEGATE_TOOL, args: { goal: "Najdi relevantni vzpominky o novem robotovi", delivery: "when_idle", ...CURRENT_TURN }, requestId: "call-1" });

  assert.equal(report.outcome.kind, "continuation");
  if (report.outcome.kind !== "continuation") throw new Error("expected a continuation");
  assert.equal(report.outcome.continuationId, "del-1");
  const instruction = JSON.parse(report.outcome.acknowledgement);
  assert.equal(instruction.type, "acknowledge-background-work");
  assert.equal(instruction.doNotInventResult, true);
  // No Czech sentence is hardcoded anywhere in the runtime; the voice model writes it.
  assert.equal(report.outcome.acknowledgement.includes("Podívám se"), false);
});

test("the delegation request is correlated to the live session, not to anything the model named", async () => {
  const broker = new RecordingBroker();
  const runtime = await voiceToolSystem(broker);
  await runtime.execute({ tool: INTELLIGENCE_DELEGATE_TOOL, args: { goal: "najdi robota", delivery: "interrupt", memory_ids: "robot-mit, robot-mars", ...CURRENT_TURN }, requestId: "call-1" });

  const accepted = broker.accepted[0]!;
  assert.equal(accepted.sessionId, "session-1");
  assert.equal(accepted.interactionId, "interaction-1");
  assert.deepEqual(accepted.selectedMemoryIds, ["robot-mit", "robot-mars"]);
  assert.deepEqual(accepted.selectedContext, [{ sourceId: "turn-7", text: "user: Mám rád malé motorky", kind: "episode" }]);
  assert.equal(accepted.delivery.mode, "interrupt");
  assert.equal(accepted.model.model, "gemini-2.5-flash");
  assert.equal(accepted.maximumModelCalls, 4);
  assert.equal(accepted.cancelOnSessionClose, true);
});

test("intelligence_delegate captures the current turn before recall context and broker acceptance", async () => {
  const order: string[] = [];
  const broker = new RecordingBroker();
  const registry = new ToolRegistry();
  registry.register(intelligenceDelegateDeclaration(), intelligenceDelegateHandler({
    broker: { ...broker, accept: async (input) => { order.push("accept"); return broker.accept(input); } } as DelegationBroker,
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    correlation: () => ({ sessionId: "session-1" }),
    captureCurrentTurn: async (input) => { order.push(`capture:${input.verbatim}`); },
    selectedContext: async () => { order.push("recall"); return []; },
    maximumModelCalls: 2,
    maximumToolCalls: 2,
    cancelOnSessionClose: true,
    defaultDelivery: { mode: "when_idle", lateResult: "queue" },
  }));
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [INTELLIGENCE_DELEGATE_TOOL] }) });
  await runtime.start();
  const report = await runtime.execute({ tool: INTELLIGENCE_DELEGATE_TOOL, requestId: "call-current", args: {
    goal: "Ulož explicitní vzpomínku.",
    current_verbatim: "Zapamatuj si, že mám rád červené motorky.",
    current_meaning: "Uživatel chce uložit, že má rád červené motorky.",
    current_language: "cs",
    current_uncertain_parts: "[]",
  } });
  assert.equal(report.outcome.kind, "continuation");
  assert.deepEqual(order, ["capture:Zapamatuj si, že mám rád červené motorky.", "recall", "accept"]);
});

test("an invalid delivery mode falls back to the configured default rather than failing the turn", async () => {
  const broker = new RecordingBroker();
  const registry = new ToolRegistry();
  registry.register(intelligenceDelegateDeclaration(), intelligenceDelegateHandler({
    broker,
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    correlation: () => ({}),
    maximumModelCalls: 1,
    maximumToolCalls: 1,
    cancelOnSessionClose: true,
    defaultDelivery: { mode: "silent", lateResult: "drop" },
  }));
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [INTELLIGENCE_DELEGATE_TOOL] }), trace: new InMemoryTraceSink() });
  await runtime.start();
  const report = await runtime.execute({ tool: INTELLIGENCE_DELEGATE_TOOL, args: { goal: "najdi robota", ...CURRENT_TURN }, requestId: "call-1" });
  assert.equal(report.outcome.kind, "continuation");
  assert.equal(broker.accepted[0]?.delivery.mode, "silent");
});

test("the voice catalogue offers delegation only, and the delegated catalogue cannot delegate", async () => {
  const memory = await seededMemory();
  const voice = await new ToolSystemRealtimeToolExecutor(await voiceToolSystem(new RecordingBroker())).discover();
  const delegated = await new ToolSystemToolClient(await delegatedToolSystem(memory)).discover();

  assert.deepEqual(voice.map((declaration) => declaration.name), [INTELLIGENCE_DELEGATE_TOOL]);
  assert.equal(voice.some((declaration) => declaration.name === MEMORY_SEARCH_TOOL), false);
  assert.equal(voice.some((declaration) => declaration.name === MEMORY_VIEW_TOOL), false);
  // Giving the delegated model this tool would let it delegate to itself.
  assert.equal(delegated.some((tool) => tool.id === INTELLIGENCE_DELEGATE_TOOL), false);
  assert.deepEqual(delegated.map((tool) => tool.id).sort(), [MEMORY_SEARCH_TOOL, MEMORY_VIEW_TOOL].sort());
});

test("realtime declarations carry full metadata derived from Tool System", async () => {
  const voice = await new ToolSystemRealtimeToolExecutor(await voiceToolSystem(new RecordingBroker())).discover();
  const declaration = voice[0]!;
  assert.equal(declaration.metadata.version, "0.1.0");
  assert.equal(declaration.metadata.sideEffect, "mutating");
  assert.equal(declaration.metadata.cancellable, true);
  assert.equal(declaration.metadata.timeoutMs, 5_000);
  assert.equal(declaration.metadata.owner, "tool-system");
  assert.equal(declaration.metadata.auditCategory, `tool.${INTELLIGENCE_DELEGATE_TOOL}`);
  assert.ok(declaration.metadata.maxResultBytes > 0);
});

test("a read-only delegated declaration is reported as read_only and low risk", async () => {
  const memory = await seededMemory();
  const registry = new ToolRegistry();
  registry.register(memorySearchDeclaration(), memorySearchHandler({ memory, subjectId: SUBJECT }));
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [MEMORY_SEARCH_TOOL] }), trace: new InMemoryTraceSink() });
  const [declaration] = await new ToolSystemRealtimeToolExecutor(runtime).discover();
  assert.equal(declaration?.metadata.sideEffect, "read_only");
  assert.equal(declaration?.metadata.risk, "low");
});
