/**
 * One conversation, one episode, one extraction — across a handoff.
 *
 * Before this, an episode was keyed to the provider session, so a handoff closed it and ran
 * memory extraction over half a conversation. That is worse than it sounds: extraction forms
 * durable beliefs, and a belief formed at the halfway point is formed before the user has
 * finished saying what they meant. "I like motorbikes" becomes a stored fact; "small ones,
 * and I sold mine last year" arrives afterwards, into a different episode.
 *
 * The second half of the same design is `conversation_recall`: until extraction runs there
 * are no memories of the current conversation at all, so the delegated model has to be able
 * to read the turns. A handoff is exactly when it needs to, because the replacement session
 * was given a summary instead of the words.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EpisodeRuntime, MemoryRuntime, SqliteEpisodeStore, SqliteMemoryStore } from "memory-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EpisodeMemoryWriter } from "../src/episode-memory.js";
import { conversationRecallHandler } from "../src/delegation/episode-tools.js";
import type { MemoryExtractionInput } from "intelligence-core";

const OLD_SESSION = "physical-session-1";
const NEW_SESSION = "physical-session-2";
const CONVERSATION = "lsn_conversation";

class RecordingExtractor {
  public readonly calls: MemoryExtractionInput[] = [];
  public async process(input: MemoryExtractionInput): Promise<void> { this.calls.push(input); }
}

async function writerOn(directory: string, resolve: (physical: string) => string) {
  const episodes = new EpisodeRuntime({ store: new SqliteEpisodeStore({ path: join(directory, "memory.sqlite") }) });
  await episodes.start();
  const extractor = new RecordingExtractor();
  const writer = new EpisodeMemoryWriter({
    episodes,
    subjectId: "primary-user",
    preferHeardInput: true,
    resolveConversationId: resolve,
    extractor: extractor as never,
  });
  return { episodes, writer, extractor };
}

/** What the runtime actually feeds it: heard records, then the session lifecycle. */
const heard = (sessionId: string, text: string) => ({ heardId: `heard-${text.slice(0, 6)}`, sessionId, verbatim: text, meaning: text, language: "cs", uncertainParts: [] as string[] });
const closed = (sessionId: string) => ({ type: "session.closed" as const, sessionId, timestampMs: 0 });

test("a handoff does not end the episode, and extraction runs once over the whole conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "episode-continuity-"));
  const { episodes, writer, extractor } = await writerOn(directory, () => CONVERSATION);
  try {
    await writer.handleHeard(heard(OLD_SESSION, "Mám rád malé motorky."));

    // The cutover: the runtime declares the replacement before the old session's close lands.
    await writer.markSuperseded(OLD_SESSION);
    await writer.handle(closed(OLD_SESSION));

    assert.deepEqual(extractor.calls, [], "extraction must not run at the cutover");

    await writer.handleHeard(heard(NEW_SESSION, "A prodal jsem ji loni na podzim."));
    await writer.handle(closed(NEW_SESSION));

    assert.equal(extractor.calls.length, 1, "one conversation, one extraction");
    const turns = extractor.calls[0]!.turns.map((turn) => turn.text);
    assert.deepEqual(turns, ["Mám rád malé motorky.", "A prodal jsem ji loni na podzim."], "both halves reached the extractor together");
    assert.equal(extractor.calls[0]!.sessionId, CONVERSATION);

    // One episode in the store, not two.
    assert.deepEqual((await episodes.listSessions("primary-user")).map((session) => session.sessionId), [CONVERSATION]);
  } finally { await episodes.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("a session closing on its own still ends the conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "episode-plain-"));
  const { episodes, writer, extractor } = await writerOn(directory, () => CONVERSATION);
  try {
    await writer.handleHeard(heard(OLD_SESSION, "Jmenuji se Šimon a bydlím v Brně."));
    await writer.handle(closed(OLD_SESSION));

    assert.equal(extractor.calls.length, 1, "a close that is not a handoff is still the end");
  } finally { await episodes.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("the delegated model can read what was said before the swap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "episode-recall-"));
  const { episodes, writer } = await writerOn(directory, () => CONVERSATION);
  try {
    await writer.handleHeard(heard(OLD_SESSION, "Mám rád malé motorky."));
    await writer.markSuperseded(OLD_SESSION);
    await writer.handle(closed(OLD_SESSION));

    const recall = conversationRecallHandler({ episodes, session: () => CONVERSATION });
    // Asked without diacritics, the way a query often arrives.
    const outcome = await recall({ query: "motorky" }, { requestId: "r1", signal: undefined } as never);

    assert.equal(outcome.kind, "result");
    assert.match(outcome.kind === "result" ? outcome.content : "", /malé motorky/, "the exact words survive the handoff, not just the summary");
    assert.equal(outcome.kind === "result" ? outcome.taint : undefined, "external", "what somebody said is data, never instruction");
  } finally { await episodes.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("recall is scoped to the live conversation and says so when there is none", async () => {
  const directory = await mkdtemp(join(tmpdir(), "episode-scope-"));
  const { episodes, writer } = await writerOn(directory, () => CONVERSATION);
  try {
    await writer.handleHeard(heard(OLD_SESSION, "Něco důvěrného z jiné konverzace."));

    const unbound = conversationRecallHandler({ episodes, session: () => undefined });
    const outcome = await unbound({}, { requestId: "r2", signal: undefined } as never);
    assert.equal(outcome.kind === "result" ? outcome.content : "", "No conversation is open.");

    // The model never names a session, so there is no id space for it to probe.
    const other = conversationRecallHandler({ episodes, session: () => "someone-elses-conversation" });
    const empty = await other({}, { requestId: "r3", signal: undefined } as never);
    assert.equal(empty.kind === "result" ? empty.content : "", "This conversation has no turns yet.");
  } finally { await episodes.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("memory extraction still writes durable memories after a handoff", async () => {
  // The end-to-end shape the smoke test checks by hand: turns survive the swap, and the
  // conversation that produced them is the one extraction is handed.
  const directory = await mkdtemp(join(tmpdir(), "episode-memory-"));
  const path = join(directory, "memory.sqlite");
  const memory = new MemoryRuntime({ store: new SqliteMemoryStore({ path }) });
  await memory.start();
  const { episodes, writer, extractor } = await writerOn(directory, () => CONVERSATION);
  try {
    await writer.handleHeard(heard(OLD_SESSION, "Piju kávu výhradně bez cukru."));
    await writer.markSuperseded(OLD_SESSION);
    await writer.handle(closed(OLD_SESSION));
    await writer.handleHeard(heard(NEW_SESSION, "A mám alergii na vlašské ořechy."));
    await writer.flush();

    assert.equal(extractor.calls.length, 1);
    assert.equal(extractor.calls[0]!.turns.length, 2, "flush closes the conversation the handoff kept open");
  } finally { await memory.stop(); await episodes.stop(); await rm(directory, { recursive: true, force: true }); }
});
