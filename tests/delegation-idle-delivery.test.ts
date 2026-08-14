/**
 * `when_idle` only means anything if something tells the scheduler when the assistant is
 * speaking. Nothing did, so results were delivered immediately regardless of the mode —
 * a scheduling policy that silently did not schedule.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { FakeRealtimeSpeechProvider, REALTIME_INPUT_FORMAT, RealtimeCore } from "realtime-core";
import { DelegationDeliveryScheduler } from "../src/delegation/delivery.js";
import type { DelegationEvent } from "../src/contracts.js";

const completed = (executionId = "del-1"): Extract<DelegationEvent, { type: "delegation.completed" }> => ({
  type: "delegation.completed",
  requestId: "req-1",
  executionId,
  sessionId: "session-1",
  status: "completed",
  result: { schema: "delegation.result.v1", data: { candidates: [] }, references: [] },
  occurredAt: "2026-08-14T12:00:00.000Z",
});

async function bound() {
  const provider = new FakeRealtimeSpeechProvider({ toolCalling: "async", contextInjection: true });
  const session = await new RealtimeCore(provider).connect({ provider: "fake", inputFormat: REALTIME_INPUT_FORMAT });
  const events: DelegationEvent[] = [];
  const delivery = new DelegationDeliveryScheduler({ emit: (event) => events.push(event) });
  delivery.bind({ sessionId: "session-1", session, contextInjection: true });
  return { provider, session, delivery, events };
}

test("a result that lands while the assistant is speaking waits for the sentence to finish", async () => {
  const { provider, session, delivery, events } = await bound();

  delivery.markOutputStarted("session-1");
  await delivery.deliver(completed(), { mode: "when_idle", lateResult: "queue" });

  assert.equal(provider.contextEvents.length, 0, "nothing is injected mid-sentence");
  assert.equal(events.at(-1)?.type, "delegation.delivery.queued");

  await delivery.markOutputFinished("session-1");
  assert.equal(provider.contextEvents.length, 1, "delivered once the assistant stopped");
  assert.equal(events.at(-1)?.type, "delegation.delivery.sent");
  await session.close();
});

test("an interrupted answer also counts as finished, so a result is not stranded", async () => {
  const { provider, session, delivery } = await bound();
  delivery.markOutputStarted("session-1");
  await delivery.deliver(completed(), { mode: "when_idle", lateResult: "queue" });
  assert.equal(delivery.queuedCount("session-1"), 1);

  // The runtime treats interruption as the end of output; if it did not, a barge-in
  // would leave the queue permanently stuck behind a sentence that never completed.
  await delivery.markOutputFinished("session-1");
  assert.equal(provider.contextEvents.length, 1);
  await session.close();
});

test("a result arriving during silence is delivered without waiting", async () => {
  const { provider, session, delivery } = await bound();
  await delivery.deliver(completed(), { mode: "when_idle", lateResult: "queue" });
  assert.equal(provider.contextEvents.length, 1);
  await session.close();
});

test("interrupt does not wait for idle, which is the whole difference between the modes", async () => {
  const { provider, session, delivery } = await bound();
  delivery.markOutputStarted("session-1");
  await delivery.deliver(completed(), { mode: "interrupt", lateResult: "queue" });
  assert.equal(provider.contextEvents.length, 1, "interrupt cuts in rather than queueing");
  await session.close();
});

test("several results queued behind one sentence are all delivered, in order", async () => {
  const { provider, session, delivery } = await bound();
  delivery.markOutputStarted("session-1");
  await delivery.deliver(completed("del-1"), { mode: "when_idle", lateResult: "queue" });
  await delivery.deliver(completed("del-2"), { mode: "when_idle", lateResult: "queue" });
  assert.equal(provider.contextEvents.length, 0);

  await delivery.markOutputFinished("session-1");
  assert.deepEqual(provider.contextEvents.map((event) => event.executionId), ["del-1", "del-2"]);
  await session.close();
});
