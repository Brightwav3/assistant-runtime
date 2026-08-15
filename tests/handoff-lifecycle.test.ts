/**
 * The handoff lifecycle, proved offline.
 *
 * Every path here is a failure path except the first: a replacement that never becomes
 * ready, a commit that races an abort, a commit attempted too early. Those are the paths
 * that decide whether a conversation survives, and none of them can be observed against a
 * live provider on demand.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HandoffCoordinator } from "../src/handoff/coordinator.js";
import { HandoffError, type HandoffEvent } from "../src/handoff/contracts.js";
import { createHarness } from "./handoff-harness.js";

const types = (events: HandoffEvent[]): string[] => events.map((event) => event.type);

/**
 * The budgets below are generous on purpose. They are real wall-clock deadlines,
 * and `node --test` runs test files in parallel, so a tight budget on a loaded CI
 * runner expires from scheduling latency rather than from the behaviour under
 * test — which surfaced as twenty-two tests cancelled, not failed.
 *
 * Tests that deliberately exercise a firing deadline set their own short value;
 * see handoff-observability.test.ts.
 */
async function coordinator(options: Parameters<typeof createHarness>[0] = {}, readyTimeoutMs = 10_000) {
  const harness = await createHarness(options);
  const handoff = new HandoffCoordinator({
    logicalSessionId: "logical-1",
    activePhysicalSessionId: harness.initialSessionId,
    controller: harness.controller,
    context: harness.context,
    emit: (event) => harness.events.push(event),
    readyTimeoutMs,
    clock: () => "2026-08-15T10:00:00.000Z",
  });
  return { harness, handoff };
}

test("prepare, ready, commit and teardown run in order under one stable logical id", async () => {
  const { harness, handoff } = await coordinator();

  await handoff.prepare("context_threshold");
  assert.equal(handoff.phase(), "ready");

  const replacementId = handoff.identity().replacementPhysicalSessionId;
  assert.ok(replacementId, "a replacement must exist once prepared");
  assert.notEqual(replacementId, harness.initialSessionId, "the replacement must be a distinct physical session");

  await handoff.commit();

  assert.deepEqual(types(harness.events), ["handoff.prepared", "handoff.ready", "handoff.committed"]);
  assert.equal(handoff.phase(), "idle", "teardown returns the coordinator to idle");
  assert.equal(handoff.identity().activePhysicalSessionId, replacementId);
  assert.equal(handoff.identity().logicalSessionId, "logical-1", "the logical id never changes");
  assert.deepEqual(harness.openSessionIds(), [replacementId], "the previous session is closed by teardown");

  const committed = harness.events.find((event) => event.type === "handoff.committed");
  assert.equal(committed?.identity.logicalSessionId, "logical-1");
});

test("commit is idempotent: a retry racing a completion produces one outcome", async () => {
  const { harness, handoff } = await coordinator();
  await handoff.prepare("manual");

  await Promise.all([handoff.commit(), handoff.commit()]);
  await handoff.commit();

  assert.equal(harness.events.filter((event) => event.type === "handoff.committed").length, 1);
  assert.equal(harness.openSessionIds().length, 1, "exactly one session survives a double commit");
});

test("commit racing abort publishes exactly one terminal event", async () => {
  const { harness, handoff } = await coordinator();
  await handoff.prepare("context_threshold");

  await Promise.all([handoff.commit(), handoff.abort("RUNTIME_SHUTDOWN")]);

  const terminal = harness.events.filter((event) => event.type === "handoff.committed" || event.type === "handoff.aborted" || event.type === "handoff.failed");
  assert.equal(terminal.length, 1);
});

test("a replacement that never becomes ready cannot be committed", async () => {
  const { harness, handoff } = await coordinator({ deferContextAck: true }, 50);

  await handoff.prepare("context_threshold");

  assert.equal(handoff.phase(), "idle", "an abandoned attempt leaves the coordinator idle, not stuck");
  assert.deepEqual(types(harness.events), ["handoff.prepared", "handoff.aborted"]);
  const aborted = harness.events.find((event) => event.type === "handoff.aborted");
  assert.equal(aborted?.type === "handoff.aborted" && aborted.failure, "REPLACEMENT_NOT_READY");
  assert.deepEqual(harness.openSessionIds(), [harness.initialSessionId], "the working session is retained");

  // Commit after a terminal outcome is a no-op, not an error — the same idempotency that
  // makes a retry safe. What must not happen is a commit.
  await handoff.commit();
  assert.equal(harness.events.some((event) => event.type === "handoff.committed"), false);
  assert.equal(handoff.identity().activePhysicalSessionId, harness.initialSessionId);
});

test("commit before any attempt has been prepared is refused", async () => {
  const { handoff } = await coordinator();
  await assert.rejects(() => handoff.commit(), (error: unknown) => error instanceof HandoffError && error.code === "HANDOFF_NOT_STARTED");
});

test("commit before ready is refused and leaves the attempt in prepare", async () => {
  const { harness, handoff } = await coordinator({ deferContextAck: true }, 5_000);

  const pending = handoff.prepare("context_threshold");
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handoff.phase(), "prepare");
  await assert.rejects(() => handoff.commit(), (error: unknown) => error instanceof HandoffError && error.code === "HANDOFF_NOT_READY");
  assert.equal(handoff.phase(), "prepare", "a refused commit does not disturb the attempt");

  const replacementId = handoff.identity().replacementPhysicalSessionId!;
  harness.provider.markReady(replacementId);
  await pending;
  assert.equal(handoff.phase(), "ready");
});

test("abort from prepare and from ready both retain the current session", async () => {
  for (const abortAfterReady of [false, true]) {
    const { harness, handoff } = await coordinator({ deferContextAck: !abortAfterReady }, 5_000);

    const pending = handoff.prepare("manual");
    if (abortAfterReady) await pending;
    else await new Promise((resolve) => setImmediate(resolve));

    await handoff.abort("PROVIDER_DISCONNECTED");
    if (!abortAfterReady) await pending;

    assert.equal(handoff.identity().activePhysicalSessionId, harness.initialSessionId);
    assert.deepEqual(harness.openSessionIds(), [harness.initialSessionId]);
    assert.equal(harness.events.filter((event) => event.type === "handoff.aborted").length, 1);
    assert.equal(harness.events.some((event) => event.type === "handoff.committed"), false);
  }
});

test("a provider that refuses to open a replacement aborts rather than failing silently", async () => {
  const { harness, handoff } = await coordinator({ failOpenAt: 1 });

  await handoff.prepare("context_threshold");

  assert.deepEqual(types(harness.events), ["handoff.aborted"]);
  const aborted = harness.events[0];
  assert.equal(aborted?.type === "handoff.aborted" && aborted.failure, "PROVIDER_DISCONNECTED");
  assert.equal(handoff.identity().activePhysicalSessionId, harness.initialSessionId);
});

test("a compaction that fails aborts the handoff and retains the session", async () => {
  const { harness, handoff } = await coordinator({ compact: async () => { throw new Error("model refused"); } });

  await handoff.prepare("context_threshold");

  const aborted = harness.events.find((event) => event.type === "handoff.aborted");
  assert.equal(aborted?.type === "handoff.aborted" && aborted.failure, "COMPACTION_FAILED");
  assert.deepEqual(harness.openSessionIds(), [harness.initialSessionId], "the replacement is closed, not left dangling");
});

test("a second prepare cannot start while one is in flight", async () => {
  const { handoff } = await coordinator({ deferContextAck: true }, 5_000);

  const pending = handoff.prepare("context_threshold");
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(() => handoff.prepare("manual"), (error: unknown) => error instanceof HandoffError && error.code === "HANDOFF_IN_PROGRESS");

  await handoff.abort("RUNTIME_SHUTDOWN");
  await pending;
});

test("a transport that dies between ready and commit reports failure without swapping ownership", async () => {
  const { harness, handoff } = await coordinator({ failActivate: true });
  await handoff.prepare("context_threshold");

  await handoff.commit();

  const failed = harness.events.find((event) => event.type === "handoff.failed");
  assert.equal(failed?.type === "handoff.failed" && failed.failure, "PROVIDER_DISCONNECTED");
  assert.equal(handoff.identity().activePhysicalSessionId, harness.initialSessionId, "ownership stays with the session that works");
});
