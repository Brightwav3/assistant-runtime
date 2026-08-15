/**
 * A handoff attempt can be interrupted at any point, and the interruptions matter more than
 * the happy path: they are what a long-running assistant actually meets.
 *
 * The invariant checked after each one is the same: the conversation still has exactly one
 * working session, and no session is left open that nothing owns. An orphaned session is
 * not a harmless leak — it is a live provider connection that keeps billing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HandoffCoordinator } from "../src/handoff/coordinator.js";
import type { HandoffEvent } from "../src/handoff/contracts.js";
import { createHarness } from "./handoff-harness.js";

async function fixture(options: Parameters<typeof createHarness>[0] = {}, readyTimeoutMs = 5_000) {
  const harness = await createHarness(options);
  const events: HandoffEvent[] = [];
  const handoff = new HandoffCoordinator({
    logicalSessionId: "logical-1",
    activePhysicalSessionId: harness.initialSessionId,
    controller: harness.controller,
    context: harness.context,
    emit: (event) => events.push(event),
    readyTimeoutMs,
  });
  return { harness, events, handoff };
}

/** After any interrupted attempt: one working session, nothing orphaned, audio still flows. */
async function assertConversationSurvives(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  assert.deepEqual(harness.openSessionIds(), [harness.initialSessionId], "no session is left open that nothing owns");
  assert.equal(harness.activeSessionId(), harness.initialSessionId);
  await harness.speak();
}

test("a provider that will not open a replacement leaves the conversation intact", async () => {
  const { harness, events, handoff } = await fixture({ failOpenAt: 1 });

  await handoff.prepare("context_threshold");

  const aborted = events.find((event) => event.type === "handoff.aborted");
  assert.equal(aborted?.type === "handoff.aborted" && aborted.failure, "PROVIDER_DISCONNECTED");
  await assertConversationSurvives(harness);
});

test("a replacement whose transport dies mid-prefill is abandoned, not committed", async () => {
  const { harness, events, handoff } = await fixture({ deferContextAck: true });

  const attempt = handoff.prepare("context_threshold");
  await new Promise((resolve) => setImmediate(resolve));
  const replacementId = handoff.identity().replacementPhysicalSessionId!;

  await harness.killSession(replacementId);
  await attempt;

  assert.equal(events.some((event) => event.type === "handoff.ready"), false);
  const aborted = events.find((event) => event.type === "handoff.aborted");
  assert.equal(aborted?.type === "handoff.aborted" && aborted.failure, "REPLACEMENT_NOT_READY");
  await assertConversationSurvives(harness);
});

test("a transport that dies between ready and commit keeps ownership on the session that works", async () => {
  const { harness, events, handoff } = await fixture({ failActivate: true });

  await handoff.prepare("context_threshold");
  await handoff.commit();

  const failed = events.find((event) => event.type === "handoff.failed");
  assert.equal(failed?.type === "handoff.failed" && failed.failure, "PROVIDER_DISCONNECTED");
  assert.equal(handoff.identity().activePhysicalSessionId, harness.initialSessionId);
  await harness.speak();
});

test("runtime shutdown during prepare closes the replacement it opened", async () => {
  const { harness, events, handoff } = await fixture({ deferContextAck: true });

  const attempt = handoff.prepare("context_threshold");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.openSessionIds().length, 2);

  await handoff.abort("RUNTIME_SHUTDOWN");
  await attempt;

  const aborted = events.find((event) => event.type === "handoff.aborted");
  assert.equal(aborted?.type === "handoff.aborted" && aborted.failure, "RUNTIME_SHUTDOWN");
  await assertConversationSurvives(harness);
});

test("runtime shutdown during ready closes the replacement rather than orphaning it", async () => {
  const { harness, events, handoff } = await fixture();

  await handoff.prepare("context_threshold");
  assert.equal(handoff.phase(), "ready");

  await handoff.abort("RUNTIME_SHUTDOWN");

  assert.equal(events.some((event) => event.type === "handoff.committed"), false);
  await assertConversationSurvives(harness);
});

test("runtime shutdown during commit cannot undo it, and leaves one session", async () => {
  const { harness, events, handoff } = await fixture();
  await handoff.prepare("context_threshold");

  await Promise.all([handoff.commit(), handoff.abort("RUNTIME_SHUTDOWN")]);

  const terminal = events.filter((event) => event.type === "handoff.committed" || event.type === "handoff.aborted" || event.type === "handoff.failed");
  assert.equal(terminal.length, 1, "a commit and a shutdown must not both be published");
  assert.equal(harness.openSessionIds().length, 1);
  await harness.speak();
});

test("an attempt that failed can be retried without leaking the previous replacement", async () => {
  const { harness, handoff } = await fixture({ deferContextAck: true }, 40);

  await handoff.prepare("context_threshold");
  await handoff.prepare("manual");
  await handoff.prepare("context_threshold");

  await assertConversationSurvives(harness);
});
