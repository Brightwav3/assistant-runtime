import assert from "node:assert/strict";
import test from "node:test";
import type { ModelExecutor, ModelRequest, ModelResponse } from "intelligence-core";
import { GeminiMemoryExtractor } from "../src/gemini-memory-extractor.js";

class FakeModel implements ModelExecutor {
  public last?: ModelRequest;
  public constructor(private readonly response: ModelResponse | Error) {}
  public async generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    this.last = request;
    if (signal?.aborted) throw new Error("cancelled");
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

const input = { subjectId: "user-1", sessionId: "session-1", turns: [{ turnId: "turn-1", speaker: "user" as const, text: "Pamatuj si, že mám rád stručné odpovědi." }] };
const response = (value: unknown): ModelResponse => ({ type: "final", message: { role: "assistant", content: JSON.stringify(value) } });

test("valid structured model output becomes a guarded memory candidate", async () => {
  const model = new FakeModel(response([{ candidateId: "candidate-1", disposition: "store", kind: "preference", subjectId: "user-1", key: "response_style", content: { type: "text", text: "User prefers concise answers" }, confidence: 0.96, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "The user explicitly stated a durable preference." }]));
  const extractor = new GeminiMemoryExtractor({ models: model, providerId: "gemini", model: "gemini-test" });
  const candidates = await extractor.extract(input);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.disposition, "store");
  assert.match(model.last?.messages[0]?.content ?? "", /JSON/);
});

test("malformed model output becomes a diagnostic and stores nothing", async () => {
  const diagnostics: Array<Record<string, unknown>> = [];
  const extractor = new GeminiMemoryExtractor({ models: new FakeModel({ type: "final", message: { role: "assistant", content: "not json" } }), providerId: "gemini", model: "gemini-test", trace: (event) => diagnostics.push(event) });
  assert.deepEqual(await extractor.extract(input), []);
  assert.ok(diagnostics.some((event) => event.type === "memory.extraction.invalid_output"));
});

test("unknown kind, invalid confidence, missing subject, and missing evidence are rejected", async () => {
  const candidates = [
    { candidateId: "bad-kind", disposition: "store", kind: "weather", subjectId: "user-1", content: { type: "text", text: "bad" }, confidence: 1, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "bad" },
    { candidateId: "bad-confidence", disposition: "store", kind: "fact", subjectId: "user-1", content: { type: "text", text: "bad" }, confidence: 2, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "bad" },
    { candidateId: "bad-subject", disposition: "store", kind: "fact", subjectId: "user-2", content: { type: "text", text: "bad" }, confidence: 1, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "bad" },
    { candidateId: "bad-evidence", disposition: "store", kind: "fact", subjectId: "user-1", content: { type: "text", text: "bad" }, confidence: 1, evidence: [], reason: "bad" },
  ];
  const extractor = new GeminiMemoryExtractor({ models: new FakeModel(response(candidates)), providerId: "gemini", model: "gemini-test" });
  assert.deepEqual(await extractor.extract(input), []);
});

test("one invalid candidate is skipped without discarding its valid neighbours", async () => {
  // Break caught: aborting the whole batch meant a single malformed proposal threw away
  // every good proposal in the same response — likely, not rare, on a model with no
  // structured-output support.
  const diagnostics: Array<Record<string, unknown>> = [];
  const extractor = new GeminiMemoryExtractor({ models: new FakeModel(response([
    { candidateId: "good-1", disposition: "store", kind: "preference", subjectId: "user-1", content: { type: "text", text: "Concise answers" }, confidence: 0.97, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "Explicit preference." },
    { candidateId: "bad", disposition: "store", kind: "weather", subjectId: "user-1", content: { type: "text", text: "bad" }, confidence: 1, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "bad" },
    { candidateId: "good-2", disposition: "episode_only", kind: "event", subjectId: "user-1", content: { type: "text", text: "Mentioned a trip" }, confidence: 0.8, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "Transient." },
  ])), providerId: "gemini", model: "gemini-test", trace: (event) => diagnostics.push(event) });
  const candidates = await extractor.extract(input);
  assert.deepEqual(candidates.map(({ candidateId }) => candidateId), ["good-1", "good-2"]);
  assert.ok(diagnostics.some((event) => event.type === "memory.candidate.invalid" && event.candidateId === "bad"));
  assert.ok(diagnostics.some((event) => event.type === "memory.extraction.partial" && event.accepted === 2 && event.rejected === 1));
});

test("provider shorthand is normalized into five runtime-bound memory candidates", async () => {
  const episode = {
    subjectId: "user-1",
    sessionId: "session-1",
    turns: [
      { turnId: "turn-profile", speaker: "user" as const, text: "Mám rád malé motorky, jmenuji se Šimon a bydlím v Brně." },
      { turnId: "turn-health", speaker: "user" as const, text: "Piju kávu bez cukru a mám alergii na vlašské ořechy." },
    ],
  };
  const extractor = new GeminiMemoryExtractor({ models: new FakeModel(response([
    { candidateId: "cand_name", disposition: "store", kind: "person", content: "Uživatel se jmenuje Šimon.", confidence: 0.99, evidence: ["turn-profile"], reason: "Explicitly stated." },
    { candidateId: "cand_location", disposition: "store", kind: "fact", content: { type: "text", text: "Uživatel bydlí v Brně." }, confidence: 0.98, evidence: [{ turnId: "turn-profile" }], reason: "Explicitly stated." },
    { candidateId: "cand_interest_motorcycles", disposition: "store", kind: "preference", content: "Uživatel má rád malé motorky.", confidence: 0.97, evidence: [{ sourceType: "conversation", sourceId: "turn-profile" }], reason: "Explicit preference." },
    { candidateId: "cand_coffee_preference", disposition: "store", kind: "preference", subjectId: "user-1", content: "Uživatel pije kávu bez cukru.", confidence: 0.97, evidence: ["turn-health"], reason: "Explicit preference." },
    { candidateId: "cand_allergy", disposition: "store", kind: "instructional", content: "Uživatel má alergii na vlašské ořechy.", confidence: 0.99, evidence: [{ sourceType: "turn", sourceId: "turn-health" }], reason: "Safety-critical explicit statement." },
  ])), providerId: "gemini", model: "gemini-test" });

  const candidates = await extractor.extract(episode);

  assert.equal(candidates.length, 5);
  assert.ok(candidates.every(({ subjectId }) => subjectId === "user-1"));
  assert.deepEqual(candidates.map(({ evidence }) => evidence[0]), [
    { sourceType: "turn", sourceId: "turn-profile" },
    { sourceType: "turn", sourceId: "turn-profile" },
    { sourceType: "turn", sourceId: "turn-profile" },
    { sourceType: "turn", sourceId: "turn-health" },
    { sourceType: "turn", sourceId: "turn-health" },
  ]);
  assert.deepEqual(candidates[0]?.content, { type: "text", text: "Uživatel se jmenuje Šimon." });
});

test("normalization never accepts a foreign subject or an evidence id outside the episode", async () => {
  const extractor = new GeminiMemoryExtractor({ models: new FakeModel(response([
    { candidateId: "foreign-subject", disposition: "store", kind: "fact", subjectId: "user-2", content: "bad", confidence: 1, evidence: ["turn-1"], reason: "bad" },
    { candidateId: "foreign-turn", disposition: "store", kind: "fact", content: "bad", confidence: 1, evidence: ["turn-other"], reason: "bad" },
  ])), providerId: "gemini", model: "gemini-test" });

  assert.deepEqual(await extractor.extract(input), []);
});

test("only high-confidence preference and instructional candidates remain auto-storable", async () => {
  const extractor = new GeminiMemoryExtractor({ models: new FakeModel(response([
    { candidateId: "transient", disposition: "episode_only", kind: "event", subjectId: "user-1", content: { type: "text", text: "Today is sunny" }, confidence: 0.99, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "Transient event." },
    { candidateId: "uncertain", disposition: "store", kind: "preference", subjectId: "user-1", content: { type: "text", text: "Maybe concise" }, confidence: 0.5, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "Uncertain." },
    { candidateId: "explicit", disposition: "store", kind: "preference", subjectId: "user-1", content: { type: "text", text: "Concise answers" }, confidence: 0.95, evidence: [{ sourceType: "turn", sourceId: "turn-1" }], reason: "Explicit preference." },
  ])), providerId: "gemini", model: "gemini-test" });
  const candidates = await extractor.extract(input);
  assert.deepEqual(candidates.map(({ candidateId, disposition }) => ({ candidateId, disposition })), [
    { candidateId: "transient", disposition: "episode_only" },
    { candidateId: "uncertain", disposition: "confirm" },
    { candidateId: "explicit", disposition: "store" },
  ]);
});

test("cancellation is forwarded to the model boundary", async () => {
  const controller = new AbortController(); controller.abort();
  const extractor = new GeminiMemoryExtractor({ models: new FakeModel(response([])), providerId: "gemini", model: "gemini-test" });
  await assert.rejects(() => extractor.extract(input, controller.signal), /cancel/i);
});
