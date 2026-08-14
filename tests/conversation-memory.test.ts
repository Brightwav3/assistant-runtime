import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EpisodeRuntime, SqliteEpisodeStore, SqliteMemoryStore, MemoryRuntime } from "memory-core";
import { EpisodeMemoryWriter } from "../src/episode-memory.js";

test("conversation turns are automatically persisted as episode records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-memory-"));
  const path = join(directory, "memory.sqlite");
  const memory = new MemoryRuntime({ store: new SqliteMemoryStore({ path }) });
  const episodes = new EpisodeRuntime({ store: new SqliteEpisodeStore({ path }) });
  await memory.start(); await episodes.start();
  try {
    const writer = new EpisodeMemoryWriter({ episodes, subjectId: "primary-user" });
    await writer.handle({ type: "transcript.final", sessionId: "session-1", text: "Řešili jsme barge-in.", source: "input", timestampMs: Date.now() });
    await writer.handle({ type: "transcript.partial", sessionId: "session-1", text: "Ano,", source: "output", timestampMs: Date.now() });
    await writer.handle({ type: "transcript.partial", sessionId: "session-1", text: " opravili jsme ho.", source: "output", timestampMs: Date.now() });
    await writer.handle({ type: "output.audio_completed", sessionId: "session-1", outputId: "output-1", timestampMs: Date.now() });
    const turns = await episodes.listTurns("session-1");
    assert.deepEqual(turns.map(({ speaker, text }) => ({ speaker, text })), [{ speaker: "user", text: "Řešili jsme barge-in." }, { speaker: "assistant", text: "Ano, opravili jsme ho." }]);
    assert.equal((await memory.list()).length, 0);
  } finally {
    await episodes.stop(); await memory.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
