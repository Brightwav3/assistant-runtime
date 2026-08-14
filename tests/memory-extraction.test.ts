import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMemoryStore, MemoryRuntime } from "memory-core";
import { MemoryExtractionOrchestrator } from "../src/memory-extraction.js";

test("stores only store candidates and reports non-persistent dispositions", async () => {
  const memory = new MemoryRuntime({ store: new InMemoryMemoryStore(), idFactory: () => "memory-1" });
  await memory.start();
  const trace: Array<Record<string, unknown>> = [];
  const orchestrator = new MemoryExtractionOrchestrator(memory, {
    extract: async () => [
      { candidateId: "store-1", disposition: "store", kind: "preference", subjectId: "user-1", content: { type: "text", text: "concise" }, confidence: 0.95, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "explicit" },
      { candidateId: "confirm-1", disposition: "confirm", kind: "fact", subjectId: "user-1", content: { type: "text", text: "maybe" }, confidence: 0.6, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "uncertain" },
      { candidateId: "discard-1", disposition: "discard", kind: "fact", subjectId: "user-1", content: { type: "text", text: "transient" }, confidence: 0.1, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "transient" },
    ],
  }, (event) => trace.push(event));
  try {
    const result = await orchestrator.process({ subjectId: "user-1", sessionId: "session-1", turns: [{ turnId: "turn-1", speaker: "user", text: "Remember concise" }] });
    assert.deepEqual(result.stored, ["store-1"]);
    assert.deepEqual((await memory.list()).map(({ memoryId }) => memoryId), ["memory-1"]);
    assert.ok(trace.some((event) => event.type === "memory.candidate.confirm"));
    assert.ok(trace.some((event) => event.type === "memory.candidate.discard"));
  } finally { await memory.stop(); }
});
