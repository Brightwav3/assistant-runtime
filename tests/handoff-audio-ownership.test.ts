/**
 * Exactly one session owns audio at every instant.
 *
 * Two sessions exist during the overlap, and both are capable of taking a microphone
 * frame. Nothing in the provider prevents feeding both — the guarantee has to come from
 * the runtime, so it has to be asserted after every transition on every path, including
 * the aborts, where the temptation to skip the check is strongest.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HandoffCoordinator } from "../src/handoff/coordinator.js";
import type { HandoffEvent } from "../src/handoff/contracts.js";
import { assertSoleAudioOwner, createHarness } from "./handoff-harness.js";

async function coordinator(options: Parameters<typeof createHarness>[0] = {}, readyTimeoutMs = 1_000) {
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
  return { harness, handoff, events };
}

test("one session owns audio through a successful handoff", async () => {
  const { harness, handoff } = await coordinator();

  await assertSoleAudioOwner(harness, assert);

  await handoff.prepare("context_threshold");
  // The replacement is open and prefilled, and must still be receiving nothing.
  assert.equal(harness.openSessionIds().length, 2, "both sessions are live during the overlap");
  await assertSoleAudioOwner(harness, assert);
  assert.equal(harness.activeSessionId(), harness.initialSessionId, "ownership does not move on ready");

  await handoff.commit();

  await assertSoleAudioOwner(harness, assert);
  assert.notEqual(harness.activeSessionId(), harness.initialSessionId, "ownership moved on commit");
  assert.equal(harness.openSessionIds().length, 1, "the previous session is gone after teardown");
});

test("the replacement receives no audio before it is committed", async () => {
  const { harness, handoff } = await coordinator();
  await handoff.prepare("context_threshold");
  const replacementId = handoff.identity().replacementPhysicalSessionId!;

  await harness.speak();
  await harness.speak();

  assert.equal(harness.frameCounts()[replacementId], 0, "a prepared session that has not committed must hear nothing");
});

test("one session owns audio through an aborted handoff", async () => {
  const { harness, handoff } = await coordinator({ deferContextAck: true }, 50);

  await assertSoleAudioOwner(harness, assert);
  await handoff.prepare("context_threshold");

  await assertSoleAudioOwner(harness, assert);
  assert.equal(harness.activeSessionId(), harness.initialSessionId);
  assert.deepEqual(harness.openSessionIds(), [harness.initialSessionId], "the abandoned replacement cannot take audio because it is closed");
});

test("one session owns audio when a commit fails at the transport", async () => {
  const { harness, handoff } = await coordinator({ failActivate: true });
  await handoff.prepare("context_threshold");

  await handoff.commit();

  await assertSoleAudioOwner(harness, assert);
  assert.equal(harness.activeSessionId(), harness.initialSessionId);
});

test("a double commit never leaves two sessions owning audio", async () => {
  const { harness, handoff } = await coordinator();
  await handoff.prepare("context_threshold");

  await Promise.all([handoff.commit(), handoff.commit()]);

  await assertSoleAudioOwner(harness, assert);
  assert.equal(harness.openSessionIds().length, 1);
});
