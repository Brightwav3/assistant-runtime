import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EpisodeRuntime, SqliteEpisodeStore } from "memory-core";
import type { RealtimeSpeechEvent } from "realtime-core";
import { EpisodeMemoryWriter } from "../src/episode-memory.js";

const event = (value: RealtimeSpeechEvent): RealtimeSpeechEvent => value;

test("maps input and cumulative output transcripts into one ordered episode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-episode-"));
  const episodes = new EpisodeRuntime({ store: new SqliteEpisodeStore({ path: join(directory, "memory.sqlite") }) });
  await episodes.start();
  try {
    const writer = new EpisodeMemoryWriter({ episodes, subjectId: "user-1", outputTranscriptMode: "cumulative" });
    await writer.handle(event({ type: "transcript.final", sessionId: "session-1", text: "Ahoj", source: "input", timestampMs: 1 }));
    await writer.handle(event({ type: "transcript.partial", sessionId: "session-1", text: "Ahoj, ", source: "output", timestampMs: 2 }));
    await writer.handle(event({ type: "transcript.partial", sessionId: "session-1", text: "Ahoj, jak ti pomohu?", source: "output", timestampMs: 3 }));
    const turns = await episodes.listTurns("session-1");
    assert.deepEqual(turns.map(({ speaker, text, sequence }) => ({ speaker, text, sequence })), [
      { speaker: "user", text: "Ahoj", sequence: 1 },
      { speaker: "assistant", text: "Ahoj, jak ti pomohu?", sequence: 2 },
    ]);
  } finally { await episodes.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("output interruption closes only the assistant turn and session close is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-episode-interrupt-"));
  const episodes = new EpisodeRuntime({ store: new SqliteEpisodeStore({ path: join(directory, "memory.sqlite") }) });
  await episodes.start();
  try {
    const writer = new EpisodeMemoryWriter({ episodes, subjectId: "user-1", outputTranscriptMode: "delta" });
    await writer.handle(event({ type: "transcript.final", sessionId: "session-1", text: "Počkej", source: "input", timestampMs: 1 }));
    await writer.handle(event({ type: "transcript.partial", sessionId: "session-1", text: "Rozumím", source: "output", timestampMs: 2 }));
    await writer.handle(event({ type: "output.interrupted", sessionId: "session-1", outputId: "output-1", timestampMs: 3 }));
    await writer.handle(event({ type: "session.closed", sessionId: "session-1", timestampMs: 4 }));
    await writer.handle(event({ type: "session.closed", sessionId: "session-1", timestampMs: 5 }));
    await writer.handle(event({ type: "transcript.final", sessionId: "session-1", text: "pozdní text", source: "input", timestampMs: 6 }));
    const turns = await episodes.listTurns("session-1");
    assert.equal(turns[1]?.status, "interrupted");
    assert.equal(turns.length, 2);
    assert.equal((await episodes.listSessions("user-1"))[0]?.status, "completed");
  } finally { await episodes.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("flush closes separate active sessions without merging their turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-episode-flush-"));
  const episodes = new EpisodeRuntime({ store: new SqliteEpisodeStore({ path: join(directory, "memory.sqlite") }) });
  await episodes.start();
  try {
    const writer = new EpisodeMemoryWriter({ episodes, subjectId: "user-1" });
    await writer.handle(event({ type: "transcript.final", sessionId: "session-a", text: "A", source: "input", timestampMs: 1 }));
    await writer.handle(event({ type: "transcript.final", sessionId: "session-b", text: "B", source: "input", timestampMs: 2 }));
    await writer.flush();
    assert.deepEqual((await episodes.listTurns("session-a")).map(({ text }) => text), ["A"]);
    assert.deepEqual((await episodes.listTurns("session-b")).map(({ text }) => text), ["B"]);
  } finally { await episodes.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
