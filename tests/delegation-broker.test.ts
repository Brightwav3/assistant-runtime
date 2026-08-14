import assert from "node:assert/strict";
import test from "node:test";

import type { AcceptedExecution, IntelligenceRequest, IntelligenceResult } from "intelligence-core";
import { RuntimeDelegationBroker, parseDelegationResult } from "../src/delegation/broker.js";
import type { DelegationEvent, DelegationRequest, DelegationStructuredResult } from "../src/contracts.js";

const RESULT: DelegationStructuredResult = {
  schema: "delegation.result.v1",
  summary: "three candidates",
  data: { candidates: ["robot-mit", "robot-mars", "submarine-project"] },
  references: [{ memoryId: "robot-mit", score: 2, matchReasons: ["robot"], provenance: { sourceType: "conversation", sourceId: "turn-1" } }],
};

/** A scripted Intelligence Core. Nothing here reaches a model or a network. */
class ScriptedIntelligence {
  public lastRequest?: IntelligenceRequest;
  public cancelled = 0;
  private resolveResult?: (result: IntelligenceResult) => void;
  private rejectResult?: (error: unknown) => void;

  public constructor(private readonly behaviour: "manual" | "immediate" | "text-only" | "reject" = "manual", private readonly error?: unknown) {}

  public accept(request: IntelligenceRequest): AcceptedExecution {
    this.lastRequest = request;
    const executionId = "exec-1";
    const result = new Promise<IntelligenceResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
      if (this.behaviour === "immediate") queueMicrotask(() => resolve(this.completion({ type: "structured", value: RESULT as unknown as Record<string, unknown> })));
      if (this.behaviour === "text-only") queueMicrotask(() => resolve(this.completion({ type: "text", text: "Nasel jsem tri moznosti." })));
      if (this.behaviour === "reject") queueMicrotask(() => reject(this.error));
    });
    return {
      executionId,
      record: () => undefined,
      result,
      cancel: async () => { this.cancelled += 1; this.rejectResult?.({ code: "EXECUTION_CANCELLED", retryable: false }); },
    };
  }

  private completion(output: IntelligenceResult["outputs"][number]): IntelligenceResult {
    return { request_id: "req-1", execution_id: "exec-1", status: "completed", outputs: [output], usage: { duration_ms: 1, model_calls: 2, tool_calls: 3 } };
  }

  public complete(value: Record<string, unknown> = RESULT as unknown as Record<string, unknown>): void {
    this.resolveResult?.(this.completion({ type: "structured", value }));
  }
}

const input = (overrides: Partial<DelegationRequest> = {}): Omit<DelegationRequest, "executionId"> => ({
  requestId: "req-1",
  sessionId: "session-1",
  interactionId: "interaction-1",
  goal: "Najdi relevantni vzpominky o novem robotovi",
  selectedMemoryIds: [],
  selectedContext: [],
  model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
  cancelOnSessionClose: true,
  maximumModelCalls: 4,
  maximumToolCalls: 8,
  delivery: { mode: "when_idle", lateResult: "queue" },
  ...overrides,
});

const brokerWith = (intelligence: ScriptedIntelligence) => {
  const events: DelegationEvent[] = [];
  let sequence = 0;
  const broker = new RuntimeDelegationBroker({ intelligence, idFactory: () => `del-${++sequence}`, clock: () => "2026-08-14T12:00:00.000Z" });
  broker.onEvent((event) => events.push(event));
  return { broker, events };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("acceptance returns before the model finishes and never carries a result", async () => {
  const intelligence = new ScriptedIntelligence("manual");
  const { broker, events } = brokerWith(intelligence);
  const accepted = await broker.accept(input());
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.executionId, "del-1");
  assert.equal(accepted.assistantInstruction.doNotInventResult, true);
  assert.equal(accepted.assistantInstruction.type, "acknowledge-background-work");
  assert.equal(events.some((event) => event.type === "delegation.completed"), false);
  assert.equal(JSON.stringify(accepted).includes("robot-mit"), false);
});

test("the acknowledgement instruction is configurable and never a hardcoded sentence", async () => {
  const broker = new RuntimeDelegationBroker({ intelligence: new ScriptedIntelligence("manual"), acknowledgementText: "Potvrd kratce a pokracuj." });
  const accepted = await broker.accept(input());
  assert.equal(accepted.assistantInstruction.text, "Potvrd kratce a pokracuj.");
});

test("lifecycle events are published in order with every correlation identifier", async () => {
  const intelligence = new ScriptedIntelligence("manual");
  const { broker, events } = brokerWith(intelligence);
  await broker.accept(input());
  intelligence.complete();
  await settle();
  assert.deepEqual(events.map((event) => event.type), [
    "delegation.created", "delegation.accepted", "delegation.started", "delegation.progress", "delegation.completed",
  ]);
  for (const event of events) {
    assert.equal(event.requestId, "req-1");
    assert.equal(event.executionId, "del-1");
    assert.equal(event.sessionId, "session-1");
    assert.equal(event.interactionId, "interaction-1");
    assert.ok(event.occurredAt);
  }
});

test("progress reports the model and tool call counts the execution actually used", async () => {
  const intelligence = new ScriptedIntelligence("immediate");
  const { broker, events } = brokerWith(intelligence);
  await broker.accept(input());
  await settle();
  const progress = events.find((event) => event.type === "delegation.progress");
  assert.equal(progress?.type === "delegation.progress" && progress.modelCalls, 2);
  assert.equal(progress?.type === "delegation.progress" && progress.toolCalls, 3);
});

test("the completed event carries the validated structured result", async () => {
  const intelligence = new ScriptedIntelligence("immediate");
  const { broker, events } = brokerWith(intelligence);
  await broker.accept(input());
  await settle();
  const completed = events.find((event) => event.type === "delegation.completed");
  assert.equal(completed?.type === "delegation.completed" && completed.result.schema, "delegation.result.v1");
  assert.equal(completed?.type === "delegation.completed" && completed.result.references[0]?.memoryId, "robot-mit");
});

test("a text-only terminal output is a safe failure, not a narrated answer", async () => {
  const intelligence = new ScriptedIntelligence("text-only");
  const { broker, events } = brokerWith(intelligence);
  await broker.accept(input());
  await settle();
  const failed = events.find((event) => event.type === "delegation.failed");
  assert.equal(failed?.type === "delegation.failed" && failed.failure.code, "DELEGATION_RESULT_INVALID");
  assert.equal(events.some((event) => event.type === "delegation.completed"), false);
});

test("a malformed structured output is rejected rather than passed through", async () => {
  const intelligence = new ScriptedIntelligence("manual");
  const { broker, events } = brokerWith(intelligence);
  await broker.accept(input());
  intelligence.complete({ schema: "something.else", data: {}, references: [] });
  await settle();
  assert.equal(events.at(-1)?.type, "delegation.failed");
});

test("a model failure crosses the boundary as a code and a retry flag only", async () => {
  const intelligence = new ScriptedIntelligence("reject", { code: "MODEL_PROVIDER_FAILED", retryable: true, message: "api key sk-secret rejected" });
  const { broker, events } = brokerWith(intelligence);
  await broker.accept(input());
  await settle();
  const failed = events.find((event) => event.type === "delegation.failed");
  assert.equal(failed?.type === "delegation.failed" && failed.failure.code, "MODEL_PROVIDER_FAILED");
  assert.equal(failed?.type === "delegation.failed" && failed.failure.retryable, true);
  assert.equal(JSON.stringify(events).includes("sk-secret"), false);
});

test("a deadline failure is reported as cancelled rather than failed", async () => {
  const intelligence = new ScriptedIntelligence("reject", { code: "EXECUTION_DEADLINE_EXCEEDED", retryable: false });
  const { broker, events } = brokerWith(intelligence);
  await broker.accept(input());
  await settle();
  assert.equal(events.at(-1)?.type, "delegation.cancelled");
});

test("cancellation is idempotent and publishes exactly one terminal event", async () => {
  const intelligence = new ScriptedIntelligence("manual");
  const { broker, events } = brokerWith(intelligence);
  const accepted = await broker.accept(input());
  await broker.cancel(accepted.executionId, "USER_CANCELLED");
  await broker.cancel(accepted.executionId, "USER_CANCELLED");
  await settle();
  const terminal = events.filter((event) => ["delegation.completed", "delegation.failed", "delegation.cancelled"].includes(event.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.type === "delegation.cancelled" && terminal[0].failure.code, "USER_CANCELLED");
  assert.equal(intelligence.cancelled, 1);
});

test("a completion arriving after cancellation does not resurrect the delegation", async () => {
  const intelligence = new ScriptedIntelligence("manual");
  const { broker, events } = brokerWith(intelligence);
  const accepted = await broker.accept(input());
  await broker.cancel(accepted.executionId);
  intelligence.complete();
  await settle();
  assert.equal(events.filter((event) => event.type === "delegation.completed").length, 0);
  assert.deepEqual(broker.activeExecutionIds(), []);
});

test("closing a session cancels only the delegations that asked for it", async () => {
  const cancelling = new ScriptedIntelligence("manual");
  const surviving = new ScriptedIntelligence("manual");
  const events: DelegationEvent[] = [];
  let sequence = 0;
  const intelligence = { accept: (request: IntelligenceRequest) => (request.request_id === "req-cancel" ? cancelling : surviving).accept(request) };
  const broker = new RuntimeDelegationBroker({ intelligence, idFactory: () => `del-${++sequence}` });
  broker.onEvent((event) => events.push(event));

  await broker.accept(input({ requestId: "req-cancel", cancelOnSessionClose: true }));
  await broker.accept(input({ requestId: "req-keep", cancelOnSessionClose: false }));
  await broker.closeSession("session-1");
  await settle();

  const cancelled = events.filter((event) => event.type === "delegation.cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]?.requestId, "req-cancel");
  assert.deepEqual(broker.activeExecutionIds(), ["del-2"]);
});

test("closing an unrelated session leaves running work alone", async () => {
  const { broker } = brokerWith(new ScriptedIntelligence("manual"));
  await broker.accept(input({ sessionId: "session-1" }));
  await broker.closeSession("session-other");
  assert.equal(broker.activeExecutionIds().length, 1);
});

test("only explicitly selected context reaches Intelligence Core", async () => {
  const intelligence = new ScriptedIntelligence("manual");
  const { broker } = brokerWith(intelligence);
  await broker.accept(input({ selectedContext: [{ sourceId: "robot-mit", text: "novy robot z MIT", kind: "memory" }] }));
  const request = intelligence.lastRequest!;
  assert.equal(request.session_id, "session-1");
  assert.equal(request.interaction_id, "interaction-1");
  assert.equal(request.execution?.maximum_model_calls, 4);
  assert.equal(request.execution?.maximum_tool_calls, 8);
  const text = request.input.type === "text" ? request.input.text : "";
  assert.ok(text.includes("novy robot z MIT"));
  assert.equal(text.includes("submarine"), false);
});

test("stop cancels everything in flight and leaves no active executions", async () => {
  const { broker, events } = brokerWith(new ScriptedIntelligence("manual"));
  await broker.accept(input());
  await broker.stop();
  await settle();
  assert.deepEqual(broker.activeExecutionIds(), []);
  assert.equal(events.at(-1)?.type, "delegation.cancelled");
});

test("result parsing accepts only a well-formed delegation result", () => {
  assert.ok(parseDelegationResult(RESULT as unknown));
  assert.equal(parseDelegationResult(undefined), undefined);
  assert.equal(parseDelegationResult("text"), undefined);
  assert.equal(parseDelegationResult([RESULT]), undefined);
  assert.equal(parseDelegationResult({ schema: "delegation.result.v1", data: {} }), undefined);
  assert.equal(parseDelegationResult({ schema: "delegation.result.v1", data: {}, references: [{ provenance: {} }] }), undefined);
  assert.ok(parseDelegationResult({ schema: "delegation.result.v1", data: {}, references: [] }));
});
