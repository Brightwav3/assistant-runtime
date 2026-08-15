import assert from "node:assert/strict";
import test from "node:test";
import { AllowlistPolicy, ToolRegistry, ToolRuntime } from "tool-system";
import { END_CONVERSATION_TOOL, endConversationDeclaration, endConversationHandler } from "../src/end-conversation-tool.js";
import { ToolSystemRealtimeToolExecutor, type LifecycleRequest } from "../src/tool-bridge.js";
import { EpisodeRuntime, SqliteEpisodeStore } from "memory-core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function executorWithEndConversation(onLifecycle?: (request: LifecycleRequest) => void) {
  const registry = new ToolRegistry();
  const error = registry.register(endConversationDeclaration(), endConversationHandler());
  assert.equal(error, null);
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [END_CONVERSATION_TOOL] }) });
  return { runtime, executor: new ToolSystemRealtimeToolExecutor(runtime, onLifecycle) };
}

test("a confirmed end request reaches the host as a shutdown, not as a silent process exit", async () => {
  const seen: LifecycleRequest[] = [];
  const { runtime, executor } = executorWithEndConversation((request) => seen.push(request));
  await runtime.start();
  try {
    const result = await executor.execute({ callId: "call-1", tool: END_CONVERSATION_TOOL, arguments: { reason: "to je vše" } });
    assert.deepEqual(seen, [{ action: "shutdown", reason: "to je vše", tool: END_CONVERSATION_TOOL }]);
    assert.match(result.content, /goodbye/i, "the model is told to sign off rather than invent an outcome");
    assert.notEqual(result.isError, true);
  } finally { await runtime.stop(); }
});

test("without a host listener the request is reported and nothing shuts down", async () => {
  // Break caught: routing shutdown around Tool System would let the tool stop the
  // process itself, with no host able to refuse.
  const { runtime, executor } = executorWithEndConversation();
  await runtime.start();
  try {
    const result = await executor.execute({ callId: "call-1", tool: END_CONVERSATION_TOOL, arguments: { reason: "vypni se" } });
    assert.ok(result.content.length > 0);
  } finally { await runtime.stop(); }
});

test("the tool refuses a call with no stated reason instead of guessing one", async () => {
  const seen: LifecycleRequest[] = [];
  const { runtime, executor } = executorWithEndConversation((request) => seen.push(request));
  await runtime.start();
  try {
    const result = await executor.execute({ callId: "call-1", tool: END_CONVERSATION_TOOL, arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(seen, [], "a rejected call must not reach the host");
  } finally { await runtime.stop(); }
});

test("an immediate repeat of the same request does not shut down twice", async () => {
  const seen: LifecycleRequest[] = [];
  const { runtime, executor } = executorWithEndConversation((request) => seen.push(request));
  await runtime.start();
  try {
    await executor.execute({ callId: "call-1", tool: END_CONVERSATION_TOOL, arguments: { reason: "to je vše" } });
    await executor.execute({ callId: "call-2", tool: END_CONVERSATION_TOOL, arguments: { reason: "to je vše" } });
    assert.equal(seen.length, 1, "the cooldown must absorb an echoed or retried call");
  } finally { await runtime.stop(); }
});

test("delegated shutdown requires a prior request followed by explicit confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "end-conversation-"));
  const episodes = new EpisodeRuntime({ store: new SqliteEpisodeStore({ path: join(directory, "memory.sqlite") }), idFactory: (() => { let id = 0; return () => `turn-${++id}`; })() });
  await episodes.start();
  await episodes.startSession({ sessionId: "session-1", subjectId: "user-1", startedAt: "2026-08-15T00:00:00Z" });
  await episodes.appendTurn("session-1", { speaker: "user", text: "To je vše, děkuji.", status: "complete", startedAt: "2026-08-15T00:00:01Z" });
  const handler = endConversationHandler({ episodes, session: () => "session-1" });
  assert.equal((await handler({ reason: "ukončit" }, {} as never)).kind, "error");
  await episodes.appendTurn("session-1", { speaker: "assistant", text: "Mám se ukončit?", status: "complete", startedAt: "2026-08-15T00:00:02Z" });
  await episodes.appendTurn("session-1", { speaker: "user", text: "Ano, ukončete se.", status: "complete", startedAt: "2026-08-15T00:00:03Z" });
  assert.equal((await handler({ reason: "Ano, ukončete se." }, {} as never)).kind, "lifecycle");
});
