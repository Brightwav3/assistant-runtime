import assert from "node:assert/strict";
import test from "node:test";
import { assessTranscript } from "../src/episode-memory.js";
import { MemoryExtractionOrchestrator } from "../src/memory-extraction.js";
import type { MemoryCandidate, MemoryExtractionInput, MemoryExtractor } from "intelligence-core";

// Measured on real conversations: the first user turn of a session is mis-detected as a
// Romance language, and very short utterances stay wrong even after detection converges.
test("the first user turn of a session is never treated as a faithful transcript", () => {
  assert.equal(assessTranscript({ text: "Ya que más gris pues este tools.", isFirstUserTurn: true }), "unreliable");
  assert.equal(assessTranscript({ text: "To je kolik minut na hodinu?", isFirstUserTurn: false }), "reliable");
});

test("a very short utterance stays unreliable however late it arrives", () => {
  for (const text of ["Ah, no.", "besser", "Ok, stop."]) {
    assert.equal(assessTranscript({ text, isFirstUserTurn: false }), "unreliable", `${text} is too short to trust`);
  }
  assert.equal(assessTranscript({ text: "Něco víc cool.", isFirstUserTurn: false }), "reliable");
});

class FixedExtractor implements MemoryExtractor {
  constructor(private readonly candidates: MemoryCandidate[]) {}
  async extract(): Promise<MemoryCandidate[]> { return this.candidates; }
}

const candidate = (evidenceTurnId: string): MemoryCandidate => ({
  candidateId: "candidate-1",
  disposition: "store",
  kind: "preference",
  subjectId: "user-1",
  content: { type: "text", text: "User prefers concise answers" },
  confidence: 0.97,
  evidence: [{ sourceType: "turn", sourceId: evidenceTurnId }],
  reason: "Stated explicitly.",
});

function inputWith(turns: MemoryExtractionInput["turns"]): MemoryExtractionInput {
  return { subjectId: "user-1", sessionId: "session-1", turns };
}

test("a candidate resting only on an unreliable transcript is held for confirmation, not stored", async () => {
  // Break caught: a mis-detected first utterance became a durable "fact" about the user.
  const stored: unknown[] = [];
  const memory = { create: async (record: unknown) => { stored.push(record); return record; } };
  const orchestrator = new MemoryExtractionOrchestrator(memory as never, new FixedExtractor([candidate("turn-1")]));
  const result = await orchestrator.process(inputWith([{ turnId: "turn-1", speaker: "user", text: "Ocon c'est ça.", transcriptConfidence: "unreliable" }]));
  assert.deepEqual(result.confirmed, ["candidate-1"]);
  assert.deepEqual(result.stored, []);
  assert.deepEqual(stored, [], "nothing may be written on a doubtful transcript alone");
});

test("a candidate backed by a reliable transcript is still stored", async () => {
  const stored: unknown[] = [];
  const memory = { create: async (record: unknown) => { stored.push(record); return record; } };
  const orchestrator = new MemoryExtractionOrchestrator(memory as never, new FixedExtractor([candidate("turn-2")]));
  const result = await orchestrator.process(inputWith([{ turnId: "turn-2", speaker: "user", text: "Preferuji stručné odpovědi.", transcriptConfidence: "reliable" }]));
  assert.deepEqual(result.stored, ["candidate-1"]);
  assert.equal(stored.length, 1);
});

test("one reliable turn among the cited evidence is enough to store", async () => {
  const stored: unknown[] = [];
  const memory = { create: async (record: unknown) => { stored.push(record); return record; } };
  const withTwo: MemoryCandidate = { ...candidate("turn-1"), evidence: [{ sourceType: "turn", sourceId: "turn-1" }, { sourceType: "turn", sourceId: "turn-2" }] };
  const orchestrator = new MemoryExtractionOrchestrator(memory as never, new FixedExtractor([withTwo]));
  const result = await orchestrator.process(inputWith([
    { turnId: "turn-1", speaker: "user", text: "Ocon c'est ça.", transcriptConfidence: "unreliable" },
    { turnId: "turn-2", speaker: "user", text: "Preferuji stručné odpovědi.", transcriptConfidence: "reliable" },
  ]));
  assert.deepEqual(result.stored, ["candidate-1"]);
});
