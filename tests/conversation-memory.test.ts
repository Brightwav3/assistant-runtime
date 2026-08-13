import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryRuntime, SqliteMemoryStore } from "memory-core";
import { ConversationMemoryWriter } from "../src/conversation-memory.js";

test("conversation turns are automatically persisted as searchable summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-memory-"));
  const memory = new MemoryRuntime({ store: new SqliteMemoryStore({ path: join(directory, "memory.sqlite") }) });
  await memory.start();
  try {
    const writer = new ConversationMemoryWriter(memory, "primary-user");
    await writer.handle({ type: "transcript.final", sessionId: "session-1", text: "Řešili jsme barge-in.", source: "input", timestampMs: Date.now() });
    await writer.handle({ type: "transcript.partial", sessionId: "session-1", text: "Ano,", source: "output", timestampMs: Date.now() });
    await writer.handle({ type: "transcript.partial", sessionId: "session-1", text: " opravili jsme ho.", source: "output", timestampMs: Date.now() });
    await writer.handle({ type: "output.audio_completed", sessionId: "session-1", outputId: "output-1", timestampMs: Date.now() });
    const found = await memory.search({ query: "barge" });
    assert.equal(found.length, 1);
    assert.match(found[0].memory.content.type === "text" ? found[0].memory.content.text : "", /opravili jsme ho/);
    assert.equal(found[0].memory.provenance.sourceType, "conversation");
  } finally {
    await memory.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
