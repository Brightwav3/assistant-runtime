import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMemoryStore, EpisodeRuntime, MemoryRuntime, SqliteEpisodeStore } from "memory-core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCreateHandler } from "../src/delegation/memory-create-tool.js";

async function fixture(text: string, confidence: "reliable" | "unreliable" = "reliable", uncertainParts: Array<{ text: string; confidence: number; uncertainty: "low" | "medium" | "high"; alternatives?: string[] }> = []) {
  const directory = await mkdtemp(join(tmpdir(), "memory-create-"));
  const episodes = new EpisodeRuntime({ store: new SqliteEpisodeStore({ path: join(directory, "memory.sqlite") }), idFactory: () => "turn-1" });
  const memory = new MemoryRuntime({ store: new InMemoryMemoryStore(), idFactory: () => "memory-1" });
  await episodes.start(); await memory.start();
  await episodes.startSession({ sessionId: "session-1", subjectId: "user-1", startedAt: "2026-08-15T00:00:00Z" });
  await episodes.appendTurn("session-1", { speaker: "user", text, verbatim: text, meaning: text, status: "complete", startedAt: "2026-08-15T00:00:01Z", transcriptConfidence: confidence, uncertainParts });
  return { memory, episodes };
}

test("explicit zapamatuj si creates a scoped memory from the bound user turn", async () => {
  const { memory, episodes } = await fixture("Zapamatujte si prosím, že piju kávu bez cukru.");
  const outcome = await memoryCreateHandler({ memory, episodes, subjectId: "user-1", session: () => "session-1" })({ turn_id: "turn-1", kind: "preference", content: "Uživatel pije kávu bez cukru." }, {} as never);
  assert.equal(outcome.kind, "result");
  assert.match(outcome.kind === "result" ? outcome.content : "", /"status":"created"/);
  assert.equal((await memory.get("memory-1"))?.scope.subjectId, "user-1");
});

test("ordinary statement cannot create explicit memory", async () => {
  for (const [text, confidence] of [["Piju kávu bez cukru.", "reliable"]] as const) {
    const { memory, episodes } = await fixture(text, confidence);
    const outcome = await memoryCreateHandler({ memory, episodes, subjectId: "user-1", session: () => "session-1" })({ turn_id: "turn-1", kind: "fact", content: text }, {} as never);
    assert.equal(outcome.kind, "error");
  }
});

test("an uncertain qualifier is omitted while the supported fact stays fully confident", async () => {
  const text = "Zapamatuj si, že moje testovací káva je výhradně bez cukru.";
  const { memory, episodes } = await fixture(text, "unreliable", [{ text: "testovací", uncertainty: "medium", confidence: 0.5 }]);
  const outcome = await memoryCreateHandler({ memory, episodes, subjectId: "user-1", session: () => "session-1" })({ turn_id: "turn-1", kind: "preference", content: "Uživatel pije kávu výhradně bez cukru." }, {} as never);
  assert.equal(outcome.kind, "result");
  const stored = await memory.get("memory-1");
  assert.equal(stored?.confidence, 1);
  assert.deepEqual(stored?.metadata?.uncertainEvidence, [{ text: "testovací", uncertainty: "medium", confidence: 0.5 }]);
});

test("confidence follows an uncertain phrase that the stored fact uses", async () => {
  const text = "Zapamatuj si, že moje káva je bez cukru.";
  const { memory, episodes } = await fixture(text, "unreliable", [{ text: "bez cukru", uncertainty: "medium", confidence: 0.5 }]);
  await memoryCreateHandler({ memory, episodes, subjectId: "user-1", session: () => "session-1" })({ turn_id: "turn-1", kind: "preference", content: "Uživatel pije kávu bez cukru." }, {} as never);
  assert.equal((await memory.get("memory-1"))?.confidence, 0.5);
});

test("a duplicate explicit request is idempotent", async () => {
  const { memory, episodes } = await fixture("Mějte na paměti, že piju kávu bez cukru.");
  const handler = memoryCreateHandler({ memory, episodes, subjectId: "user-1", session: () => "session-1" });
  const args = { turn_id: "turn-1", kind: "preference", content: "Uživatel pije kávu bez cukru." };
  await handler(args, {} as never);
  const second = await handler(args, {} as never);
  assert.equal(second.kind, "result");
  assert.match(second.kind === "result" ? second.content : "", /"status":"already_exists"/);
});
