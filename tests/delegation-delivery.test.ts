import assert from "node:assert/strict";
import test from "node:test";

import { FakeRealtimeSpeechProvider, REALTIME_INPUT_FORMAT, RealtimeCore, type RealtimeContextEvent, type RealtimeSpeechSession } from "realtime-core";
import { DelegationDeliveryScheduler } from "../src/delegation/delivery.js";
import type { DelegationDeliveryPolicy, DelegationEvent, DelegationStructuredResult } from "../src/contracts.js";

const RESULT: DelegationStructuredResult = {
  schema: "delegation.result.v1",
  summary: "three candidates",
  data: { candidates: ["robot-mit", "robot-mars", "submarine-project"] },
  references: [{ memoryId: "robot-mit", provenance: { sourceType: "conversation" } }],
};

const completed = (sessionId = "session-1"): Extract<DelegationEvent, { type: "delegation.completed" }> => ({
  type: "delegation.completed",
  requestId: "req-1",
  executionId: "del-1",
  sessionId,
  interactionId: "interaction-1",
  status: "completed",
  delivery: { mode: "when_idle", lateResult: "queue" },
  result: RESULT,
  occurredAt: "2026-08-14T12:00:00.000Z",
});

const policy = (mode: DelegationDeliveryPolicy["mode"], lateResult: DelegationDeliveryPolicy["lateResult"] = "queue"): DelegationDeliveryPolicy => ({ mode, lateResult });

async function nativeSession(): Promise<{ session: RealtimeSpeechSession; provider: FakeRealtimeSpeechProvider }> {
  const provider = new FakeRealtimeSpeechProvider({ toolCalling: "async", contextInjection: true });
  const session = await new RealtimeCore(provider).connect({ provider: "fake", inputFormat: REALTIME_INPUT_FORMAT });
  return { session, provider };
}

async function degradedSession(): Promise<{ session: RealtimeSpeechSession; provider: FakeRealtimeSpeechProvider; texts: string[] }> {
  const provider = new FakeRealtimeSpeechProvider({ toolCalling: "blocking", contextInjection: false });
  const session = await new RealtimeCore(provider).connect({ provider: "fake", inputFormat: REALTIME_INPUT_FORMAT });
  const texts: string[] = [];
  const original = session.sendText.bind(session);
  session.sendText = async (text: string) => { texts.push(text); await original(text); };
  return { session, provider, texts };
}

function scheduler() {
  const events: DelegationEvent[] = [];
  return { events, scheduler: new DelegationDeliveryScheduler({ emit: (event) => events.push(event) }) };
}

test("a delegated result reaches the session as a labelled context event, not user speech", async () => {
  const { session, provider } = await nativeSession();
  const { scheduler: delivery, events } = scheduler();
  delivery.bind({ sessionId: "session-1", session, contextInjection: true });

  await delivery.deliver(completed(), policy("when_idle"));

  assert.equal(provider.contextEvents.length, 1);
  const context = provider.contextEvents[0] as RealtimeContextEvent;
  assert.equal(context.source, "delegation");
  assert.equal(context.type, "delegation.result");
  assert.equal(context.status, "completed");
  assert.equal(context.executionId, "del-1");
  assert.equal(context.interactionId, "interaction-1");
  assert.equal(context.content.type, "structured");
  assert.equal(events.at(-1)?.type, "delegation.delivery.sent");
  assert.equal(events.at(-1)?.type === "delegation.delivery.sent" && events.at(-1)?.source, "delegation");
  await session.close();
});

test("interrupt cuts the current answer off before injecting the result", async () => {
  const { session, provider } = await nativeSession();
  const order: string[] = [];
  const interrupt = session.interrupt.bind(session);
  session.interrupt = async () => { order.push("interrupt"); await interrupt(); };
  session.sendContextEvent = async (event) => { order.push("context"); provider.recordContextEvent(event); };

  const { scheduler: delivery } = scheduler();
  delivery.bind({ sessionId: "session-1", session, contextInjection: true });
  delivery.markOutputStarted("session-1");

  await delivery.deliver(completed(), policy("interrupt"));

  assert.deepEqual(order, ["interrupt", "context"]);
  await session.close();
});

test("when_idle waits while the assistant is speaking and delivers once it stops", async () => {
  const { session, provider } = await nativeSession();
  const { scheduler: delivery, events } = scheduler();
  delivery.bind({ sessionId: "session-1", session, contextInjection: true });
  delivery.markOutputStarted("session-1");

  await delivery.deliver(completed(), policy("when_idle"));
  assert.equal(provider.contextEvents.length, 0);
  assert.equal(events.at(-1)?.type, "delegation.delivery.queued");
  assert.equal(delivery.queuedCount("session-1"), 1);

  await delivery.markOutputFinished("session-1");
  assert.equal(provider.contextEvents.length, 1);
  assert.equal(events.at(-1)?.type, "delegation.delivery.sent");
  await session.close();
});

test("silent never speaks but is still recorded as delivered", async () => {
  const { session, provider } = await nativeSession();
  const { scheduler: delivery, events } = scheduler();
  delivery.bind({ sessionId: "session-1", session, contextInjection: true });

  await delivery.deliver(completed(), policy("silent"));

  assert.equal(provider.contextEvents.length, 0);
  assert.equal(events.at(-1)?.type, "delegation.delivery.sent");
  await session.close();
});

test("without native injection the runtime takes an announced degraded path", async () => {
  const { session, texts } = await degradedSession();
  const { scheduler: delivery, events } = scheduler();
  delivery.bind({ sessionId: "session-1", session, contextInjection: false });

  await delivery.deliver(completed(), policy("when_idle"));

  assert.equal(events.some((event) => event.type === "delegation.delivery.degraded"), true);
  assert.equal(events.at(-1)?.type, "delegation.delivery.sent");
  assert.equal(texts.length, 1);
  const payload = JSON.parse(texts[0]!);
  assert.equal(payload.source, "delegation");
  assert.equal(payload.status, "completed");
  await session.close();
});

test("the degraded diagnostic precedes the send so a trace cannot confuse the two paths", async () => {
  const { session } = await degradedSession();
  const { scheduler: delivery, events } = scheduler();
  delivery.bind({ sessionId: "session-1", session, contextInjection: false });
  await delivery.deliver(completed(), policy("when_idle"));
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf("delegation.delivery.degraded") < types.indexOf("delegation.delivery.sent"));
  await session.close();
});

test("a result for an unknown session is queued or dropped by its late policy", async () => {
  const { scheduler: queueing, events: queuedEvents } = scheduler();
  await queueing.deliver(completed(), policy("when_idle", "queue"));
  assert.equal(queuedEvents.at(-1)?.type, "delegation.delivery.queued");

  const { scheduler: dropping, events: droppedEvents } = scheduler();
  await dropping.deliver(completed(), policy("when_idle", "drop"));
  assert.equal(droppedEvents.at(-1)?.type, "delegation.delivery.dropped");

  const { scheduler: persisting, events: persistedEvents } = scheduler();
  await persisting.deliver(completed(), policy("when_idle", "persist"));
  assert.equal(persistedEvents.at(-1)?.type, "delegation.delivery.queued");
});

test("a result with no session at all is dropped with a reason", async () => {
  const { scheduler: delivery, events } = scheduler();
  await delivery.deliver({ ...completed(), sessionId: undefined }, policy("when_idle"));
  const last = events.at(-1);
  assert.equal(last?.type, "delegation.delivery.dropped");
  assert.equal(last?.type === "delegation.delivery.dropped" && last.reason, "NO_SESSION");
});

test("a reconnect drains what was waiting into the new transport", async () => {
  const { scheduler: delivery, events } = scheduler();
  await delivery.deliver(completed(), policy("when_idle", "queue"));
  assert.equal(events.at(-1)?.type, "delegation.delivery.queued");

  const { session, provider } = await nativeSession();
  await delivery.rebind({ sessionId: "session-1", session, contextInjection: true });

  assert.equal(provider.contextEvents.length, 1);
  assert.equal(events.at(-1)?.type, "delegation.delivery.sent");
  await session.close();
});

test("closing a session queues survivable results and drops the ones told to drop", async () => {
  const { session } = await nativeSession();
  const { scheduler: delivery, events } = scheduler();
  delivery.bind({ sessionId: "session-1", session, contextInjection: true });
  delivery.markOutputStarted("session-1");
  await delivery.deliver({ ...completed(), executionId: "del-keep" }, policy("when_idle", "queue"));
  await delivery.deliver({ ...completed(), executionId: "del-drop" }, policy("when_idle", "drop"));

  await delivery.closeSession("session-1");

  const dropped = events.filter((event) => event.type === "delegation.delivery.dropped");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.executionId, "del-drop");
  await session.close();
});

test("the queue is bounded and says what it evicted", async () => {
  const events: DelegationEvent[] = [];
  const delivery = new DelegationDeliveryScheduler({ emit: (event) => events.push(event), maxQueueLength: 2 });
  const { session } = await nativeSession();
  delivery.bind({ sessionId: "session-1", session, contextInjection: true });
  delivery.markOutputStarted("session-1");

  for (const executionId of ["a", "b", "c"]) await delivery.deliver({ ...completed(), executionId }, policy("when_idle"));

  const dropped = events.filter((event) => event.type === "delegation.delivery.dropped");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.executionId, "a");
  assert.equal(dropped[0]?.type === "delegation.delivery.dropped" && dropped[0].reason, "QUEUE_OVERFLOW");
  assert.equal(delivery.queuedCount("session-1"), 2);
  await session.close();
});

test("user input continues while a delegation is pending and is never confused with the result", async () => {
  const { session, provider } = await nativeSession();
  const seen: Array<{ type: string; source?: string }> = [];
  const reader = (async () => {
    for await (const event of session.events()) {
      seen.push({ type: event.type, ...("source" in event ? { source: event.source } : {}) });
      if (event.type === "session.closed") return;
    }
  })();

  const { scheduler: delivery } = scheduler();
  delivery.bind({ sessionId: "session-1", session, contextInjection: true });
  await session.sendAudio({ streamId: "mic", timestampMs: 0, format: REALTIME_INPUT_FORMAT, data: new Int16Array(320) });
  await delivery.deliver(completed(), policy("when_idle"));

  await session.close();
  await reader;

  assert.equal(provider.contextEvents.length, 1);
  const transcripts = seen.filter((event) => event.type === "transcript.final");
  assert.equal(transcripts.length, 1, "only the user's own speech is a transcript");
  assert.equal(transcripts[0]?.source, "input");
  assert.equal(JSON.stringify(seen).includes("robot-mit"), false, "the result must not appear in the transcript stream");
});
