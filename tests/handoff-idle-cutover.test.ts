/**
 * The cutover happens in a gap, or it does not happen.
 *
 * Every test here is about a moment that is a few hundred milliseconds wide. The
 * interesting one is the last: a user who starts speaking *after* the gap was observed but
 * *before* the swap executes. That window is small, and it is precisely the window a real
 * interruption lands in.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DelegationDeliveryScheduler } from "../src/delegation/delivery.js";
import { HandoffCoordinator } from "../src/handoff/coordinator.js";
import { SessionIdleGate, waitForIdle, type HandoffIdleGate } from "../src/handoff/idle-gate.js";
import type { HandoffEvent } from "../src/handoff/contracts.js";
import { createHarness } from "./handoff-harness.js";

/**
 * The budgets below are generous on purpose. They are real wall-clock deadlines,
 * and `node --test` runs test files in parallel, so a tight budget on a loaded CI
 * runner expires from scheduling latency rather than from the behaviour under
 * test — which surfaced as twenty-two tests cancelled, not failed.
 *
 * Tests that deliberately exercise a firing deadline set their own short value;
 * see handoff-observability.test.ts.
 */
async function fixture(idle: HandoffIdleGate, idleWaitTimeoutMs = 1_000) {
  const harness = await createHarness();
  const events: HandoffEvent[] = [];
  const handoff = new HandoffCoordinator({
    logicalSessionId: "logical-1",
    activePhysicalSessionId: harness.initialSessionId,
    controller: harness.controller,
    context: harness.context,
    emit: (event) => events.push(event),
    readyTimeoutMs: 10_000,
    idle,
    idleWaitTimeoutMs,
  });
  return { harness, events, handoff };
}

function gate(): { gate: SessionIdleGate; scheduler: DelegationDeliveryScheduler; sessionId: string } {
  const scheduler = new DelegationDeliveryScheduler();
  const sessionId = "session-1";
  return { gate: new SessionIdleGate(scheduler, sessionId), scheduler, sessionId };
}

test("the commit waits while the assistant is speaking and lands on the first gap", async () => {
  const { gate: idle, scheduler, sessionId } = gate();
  const { harness, events, handoff } = await fixture(idle, 5_000);

  scheduler.markOutputStarted(sessionId);
  await handoff.prepare("context_threshold");

  const pending = handoff.commitWhenIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "handoff.committed"), false, "no cutover while the assistant is mid-sentence");
  assert.equal(harness.activeSessionId(), harness.initialSessionId);

  await scheduler.markOutputFinished(sessionId);
  await pending;

  assert.equal(events.some((event) => event.type === "handoff.committed"), true);
  assert.notEqual(harness.activeSessionId(), harness.initialSessionId);
});

test("the commit waits while the user is speaking, even when the assistant is silent", async () => {
  const { gate: idle } = gate();
  const { events, handoff } = await fixture(idle, 5_000);

  idle.markUserSpeechStarted();
  await handoff.prepare("context_threshold");

  const pending = handoff.commitWhenIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "handoff.committed"), false, "cutting over mid-utterance loses the half already received");

  idle.markUserSpeechFinished();
  await pending;
  assert.equal(events.some((event) => event.type === "handoff.committed"), true);
});

test("a session that never goes idle aborts on its deadline instead of cutting over or hanging", async () => {
  const { gate: idle, scheduler, sessionId } = gate();
  const { harness, events, handoff } = await fixture(idle, 60);

  scheduler.markOutputStarted(sessionId);
  await handoff.prepare("context_threshold");
  await handoff.commitWhenIdle();

  const aborted = events.find((event) => event.type === "handoff.aborted");
  assert.equal(aborted?.type === "handoff.aborted" && aborted.failure, "NO_IDLE_GAP");
  assert.equal(events.some((event) => event.type === "handoff.committed"), false);
  assert.equal(harness.activeSessionId(), harness.initialSessionId, "the working session is retained");
  assert.deepEqual(harness.openSessionIds(), [harness.initialSessionId]);
});

test("a user who starts speaking between the observed gap and the swap is not cut over", async () => {
  const { gate: idle, scheduler, sessionId } = gate();

  // A gate that reports the gap once, then reports the user speaking on the re-check —
  // exactly the race the re-check exists for.
  let checks = 0;
  const racing: HandoffIdleGate = {
    isIdle: () => {
      checks += 1;
      return checks > 1 ? false : idle.isIdle();
    },
    onIdle: (listener) => idle.onIdle(listener),
  };

  const { harness, events, handoff } = await fixture(racing, 60);
  scheduler.markOutputStarted(sessionId);
  await handoff.prepare("context_threshold");

  await handoff.commitWhenIdle();

  assert.equal(events.some((event) => event.type === "handoff.committed"), false, "the re-check must catch a gap that closed");
  assert.equal(harness.activeSessionId(), harness.initialSessionId);
});

test("an already-idle session commits without waiting", async () => {
  const { gate: idle } = gate();
  const { events, handoff } = await fixture(idle, 5_000);

  await handoff.prepare("context_threshold");
  await handoff.commitWhenIdle();

  assert.equal(events.some((event) => event.type === "handoff.committed"), true);
});

test("waitForIdle reports the deadline rather than resolving optimistically", async () => {
  const { gate: idle, scheduler, sessionId } = gate();
  scheduler.markOutputStarted(sessionId);

  assert.equal(await waitForIdle(idle, 30), false);

  await scheduler.markOutputFinished(sessionId);
  assert.equal(await waitForIdle(idle, 30), true);
});

test("the idle gate reads the delivery scheduler rather than tracking output a second time", async () => {
  const { gate: idle, scheduler, sessionId } = gate();

  assert.equal(idle.isIdle(), true);
  scheduler.markOutputStarted(sessionId);
  assert.equal(idle.isIdle(), false, "the gate and when_idle delivery must answer the same question the same way");
  assert.equal(scheduler.isIdle(sessionId), false);
  await scheduler.markOutputFinished(sessionId);
  assert.equal(idle.isIdle(), true);
  assert.equal(scheduler.isIdle(sessionId), true);
});
