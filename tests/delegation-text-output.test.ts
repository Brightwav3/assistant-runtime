/**
 * Regression cover for the failure the scripted end-to-end test could not see.
 *
 * ActionRuntime always returns `{ type: "text" }` — a text model returns text even when
 * it is returning JSON. The broker originally demanded a `structured` output, so every
 * real delegation failed while the test that scripted a structured return passed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { FakeModelProvider, ModelGateway } from "intelligence-core";
import { InMemoryMemoryStore, MemoryRuntime, type CreateMemoryInput } from "memory-core";

import { readDelegationOutput } from "../src/delegation/broker.js";
import { createDelegation } from "../src/delegation/composition.js";
import type { DelegationEvent, DelegationSettings, UsageSettings } from "../src/index.js";

const RESULT = {
  schema: "delegation.result.v1",
  summary: "nasel jsem tri moznosti",
  data: { candidates: [{ memoryId: "robot-mit", label: "robot z MIT" }] },
  references: [{ memoryId: "robot-mit", score: 2, matchReasons: ["robot"], provenance: { sourceType: "conversation" } }],
};

test("a plain JSON text output is accepted", () => {
  const parsed = readDelegationOutput({ type: "text", text: JSON.stringify(RESULT) });
  assert.equal(parsed?.schema, "delegation.result.v1");
  assert.equal(parsed?.references[0]?.memoryId, "robot-mit");
});

test("a markdown-fenced JSON output is accepted, because models emit fences", () => {
  const fenced = readDelegationOutput({ type: "text", text: "```json\n" + JSON.stringify(RESULT) + "\n```" });
  assert.equal(fenced?.schema, "delegation.result.v1");
  const bare = readDelegationOutput({ type: "text", text: "```\n" + JSON.stringify(RESULT) + "\n```" });
  assert.equal(bare?.schema, "delegation.result.v1");
});

test("a JSON object wrapped in an explanatory sentence is still recovered", () => {
  const parsed = readDelegationOutput({ type: "text", text: `Here is the result:\n${JSON.stringify(RESULT)}\nHope that helps.` });
  assert.equal(parsed?.schema, "delegation.result.v1");
});

test("prose is still refused rather than narrated", () => {
  assert.equal(readDelegationOutput({ type: "text", text: "Našel jsem tři možnosti: robota z MIT, pro Mars a ponorku." }), undefined);
  assert.equal(readDelegationOutput({ type: "text", text: "" }), undefined);
  assert.equal(readDelegationOutput({ type: "text", text: "{ not json at all" }), undefined);
  // Right shape, wrong schema — must not slip through on structure alone.
  assert.equal(readDelegationOutput({ type: "text", text: JSON.stringify({ schema: "other.v1", data: {}, references: [] }) }), undefined);
});

test("a structured output still works unchanged", () => {
  assert.equal(readDelegationOutput({ type: "structured", value: RESULT })?.schema, "delegation.result.v1");
});

test("a delegation through the real action loop completes on a text-returning model", async () => {
  const memory = new MemoryRuntime({ store: new InMemoryMemoryStore(), idFactory: () => "robot-mit" });
  await memory.start();
  const seed: CreateMemoryInput = {
    kind: "project",
    content: { type: "text", text: "Nový robot z MIT: laboratorní manipulátor" },
    scope: { type: "user", subjectId: "user-1" },
    provenance: { sourceType: "conversation", sourceId: "turn-1" },
    confidence: 0.9,
  };
  await memory.create(seed);

  const models = new ModelGateway();
  // Exactly what a real text model does: JSON, as text, inside a fence.
  models.register(new FakeModelProvider({
    id: "gemini",
    responses: [{ type: "final", message: { role: "assistant", content: "```json\n" + JSON.stringify(RESULT) + "\n```" } }],
  }));

  const delegationSettings: DelegationSettings = {
    enabled: true, provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [],
    deadlineMs: 10_000, maximumModelCalls: 3, maximumToolCalls: 6,
    cancelOnSessionClose: true, defaultDelivery: "when_idle", lateResultPolicy: "queue",
  };
  const usage: UsageSettings = { enabled: false, path: "", maxRecords: 100, unknownCostPolicy: "allow", priceCatalogVersion: "test" };

  const events: DelegationEvent[] = [];
  const composition = createDelegation({
    delegation: delegationSettings, usage, memory, subjectId: "user-1",
    correlation: () => ({ sessionId: "session-1" }),
    modelGateway: models,
  });
  composition.broker.onEvent((event) => events.push(event));
  await composition.start();

  try {
    await composition.broker.accept({
      requestId: "req-1", sessionId: "session-1", goal: "Najdi relevantní vzpomínky o novém robotovi",
      selectedMemoryIds: [], selectedContext: [],
      model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
      cancelOnSessionClose: true, maximumModelCalls: 3, maximumToolCalls: 6,
      delivery: { mode: "when_idle", lateResult: "queue" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const failed = events.find((event) => event.type === "delegation.failed");
    assert.equal(failed, undefined, `delegation should not fail: ${JSON.stringify(failed)}`);
    const completed = events.find((event) => event.type === "delegation.completed");
    assert.ok(completed, "the delegation completed on a text-returning model");
    assert.equal(completed?.type === "delegation.completed" && completed.result.references[0]?.memoryId, "robot-mit");
  } finally {
    await composition.stop();
    await memory.stop();
  }
});
