/**
 * Correlation identity survives a commit.
 *
 * The whole inversion — the runtime holds the conversation, the session only renders it —
 * is worth nothing if downstream consumers key on the physical session. A delegation
 * submitted before the swap and finishing after it must come back to the same conversation,
 * not be dropped as belonging to a session that no longer exists.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DelegationDeliveryScheduler } from "../src/delegation/delivery.js";
import { HandoffCoordinator } from "../src/handoff/coordinator.js";
import type { DelegationEvent } from "../src/contracts.js";
import { createHarness } from "./handoff-harness.js";

const LOGICAL = "logical-1";

const completed = (executionId: string): Extract<DelegationEvent, { type: "delegation.completed" }> => ({
  type: "delegation.completed",
  requestId: `req-${executionId}`,
  executionId,
  sessionId: LOGICAL,
  status: "completed",
  result: { schema: "delegation.result.v1", summary: "found it", data: {}, references: [] },
  occurredAt: "2026-08-15T10:00:00.000Z",
});

test("a delegation that outlives the session it was asked in is delivered to the replacement", async () => {
  const harness = await createHarness();
  const provider = harness.provider;
  const events: DelegationEvent[] = [];
  const delivery = new DelegationDeliveryScheduler({ emit: (event) => events.push(event) });

  // Everything downstream is keyed on the logical id, which is why the rebind below works.
  const initial = provider.sessions().find((session) => session.id === harness.initialSessionId)!;
  delivery.bind({ sessionId: LOGICAL, session: initial, contextInjection: true });

  const handoff = new HandoffCoordinator({
    logicalSessionId: LOGICAL,
    activePhysicalSessionId: harness.initialSessionId,
    controller: harness.controller,
    context: harness.context,
    readyTimeoutMs: 1_000,
  });

  await handoff.prepare("context_threshold");

  // Asked during the old session, still outstanding, and the assistant is speaking.
  delivery.markOutputStarted(LOGICAL);
  await delivery.deliver(completed("del-1"), { mode: "when_idle", lateResult: "queue" });
  assert.equal(delivery.queuedCount(LOGICAL), 1);

  await handoff.commit();
  const replacementId = handoff.identity().activePhysicalSessionId;
  const replacement = provider.sessions().find((session) => session.id === replacementId)!;
  await delivery.rebind({ sessionId: LOGICAL, session: replacement, contextInjection: true });

  const sent = events.filter((event) => event.type === "delegation.delivery.sent");
  assert.equal(sent.length, 1, "the queued result reached the conversation, not a closed session");
  assert.equal(sent[0]?.sessionId, LOGICAL, "delivery still keys on the logical id");
  assert.equal(provider.contextEvents.at(-1)?.sessionId, LOGICAL);
  assert.equal(delivery.queuedCount(LOGICAL), 0);
});

test("the logical id is what downstream consumers see, before and after the swap", async () => {
  const harness = await createHarness();
  const seen: string[] = [];
  const handoff = new HandoffCoordinator({
    logicalSessionId: LOGICAL,
    activePhysicalSessionId: harness.initialSessionId,
    controller: harness.controller,
    context: harness.context,
    readyTimeoutMs: 1_000,
    emit: (event) => seen.push(event.identity.logicalSessionId),
  });

  await handoff.prepare("context_threshold");
  const before = handoff.identity().activePhysicalSessionId;
  await handoff.commit();
  const after = handoff.identity().activePhysicalSessionId;

  assert.notEqual(before, after, "the physical session did change");
  assert.deepEqual([...new Set(seen)], [LOGICAL], "every event reported the same conversation");
  assert.equal(handoff.identity().logicalSessionId, LOGICAL);
});

test("delegations bound to the logical id are not cancelled by the physical swap", async () => {
  const harness = await createHarness();
  const events: DelegationEvent[] = [];
  const delivery = new DelegationDeliveryScheduler({ emit: (event) => events.push(event) });
  const initial = harness.provider.sessions().find((session) => session.id === harness.initialSessionId)!;
  delivery.bind({ sessionId: LOGICAL, session: initial, contextInjection: true });

  const handoff = new HandoffCoordinator({
    logicalSessionId: LOGICAL,
    activePhysicalSessionId: harness.initialSessionId,
    controller: harness.controller,
    context: harness.context,
    readyTimeoutMs: 1_000,
  });

  await handoff.prepare("context_threshold");
  await handoff.commit();

  // The physical session closed during teardown. Nothing told the scheduler the logical
  // session ended, because it did not.
  assert.equal(events.some((event) => event.type === "delegation.delivery.dropped"), false);
});
