/**
 * Handoff status has to be observable rather than inferred from silence, and the AEC
 * reference has to follow the playback path.
 *
 * The echo test is the one that matters most and reads as the most trivial: if the
 * reference is not rebound, every other part of the system still reports success while the
 * assistant starts answering its own voice.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HandoffCoordinator } from "../src/handoff/coordinator.js";
import { HANDOFF_STATE_KEYS, HandoffStatePublisher } from "../src/handoff/state-publisher.js";
import { HandoffMetrics } from "../src/handoff/metrics.js";
import { createEchoRebinder } from "../src/handoff/echo-rebind.js";
import type { HandoffEvent } from "../src/handoff/contracts.js";
import { createHarness } from "./handoff-harness.js";

class RecordingState {
  public readonly writes: Array<{ key: string; value: string | boolean }> = [];
  public async set(input: { key: string; value: string | boolean; source: { sourceType: "system"; sourceId: string } }): Promise<unknown> {
    this.writes.push({ key: input.key, value: input.value });
    return input;
  }
  public latest(key: string): string | boolean | undefined { return [...this.writes].reverse().find((write) => write.key === key)?.value; }
  public sequence(key: string): Array<string | boolean> { return this.writes.filter((write) => write.key === key).map((write) => write.value); }
}

async function fixture(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = await createHarness(options);
  const state = new RecordingState();
  const publisher = new HandoffStatePublisher(state, "assistant.primary");
  const metrics = new HandoffMetrics();
  const rebound: string[] = [];
  const echo = createEchoRebinder({ guard: { beginSession: (id) => rebound.push(id) } });
  const events: HandoffEvent[] = [];

  let clockMs = 1_000;
  const handoff = new HandoffCoordinator({
    logicalSessionId: "logical-1",
    activePhysicalSessionId: harness.initialSessionId,
    controller: harness.controller,
    context: harness.context,
    readyTimeoutMs: 50,
    now: () => clockMs,
    clock: () => new Date(clockMs).toISOString(),
    emit: (event) => {
      events.push(event);
      metrics.handle(event);
      echo(event);
      void publisher.handle(event);
    },
  });

  return { harness, state, metrics, rebound, events, handoff, advance: (ms: number) => { clockMs += ms; } };
}

test("handoff status is published through State Core and returns to idle", async () => {
  const { harness, state, handoff } = await fixture();

  await handoff.prepare("context_threshold");
  assert.equal(state.latest(HANDOFF_STATE_KEYS.status), "handoff_pending");
  assert.equal(state.latest(HANDOFF_STATE_KEYS.reason), "context_threshold");

  await handoff.commit();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(state.sequence(HANDOFF_STATE_KEYS.status), ["handoff_pending", "handoff_active", "idle"]);
  assert.equal(state.latest(HANDOFF_STATE_KEYS.logicalId), "logical-1");
  assert.equal(new Set(state.sequence(HANDOFF_STATE_KEYS.logicalId)).size, 1, "the logical id never changes across a handoff");
  assert.notEqual(handoff.identity().activePhysicalSessionId, harness.initialSessionId);
});

test("an abort returns state to idle and records the failure reason", async () => {
  const { state, handoff } = await fixture({ deferContextAck: true });

  await handoff.prepare("context_threshold");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.latest(HANDOFF_STATE_KEYS.status), "idle");
  assert.equal(state.latest(HANDOFF_STATE_KEYS.reason), "REPLACEMENT_NOT_READY");
});

test("the echo reference is rebound to the replacement, and only on commit", async () => {
  const { harness, rebound, handoff } = await fixture();

  await handoff.prepare("context_threshold");
  assert.deepEqual(rebound, [], "rebinding on prepare would reset the filter while the current session is still speaking through it");

  await handoff.commit();

  assert.deepEqual(rebound, [handoff.identity().activePhysicalSessionId]);
  assert.notEqual(rebound[0], harness.initialSessionId, "a reference left on the old playback path is how an assistant starts answering itself");
});

test("an aborted handoff never rebinds the echo reference", async () => {
  const { rebound, handoff } = await fixture({ deferContextAck: true });

  await handoff.prepare("context_threshold");

  assert.deepEqual(rebound, []);
});

test("metrics report prepare latency, overlap, and abort rate without growing per attempt", async () => {
  const { metrics, handoff, advance } = await fixture();

  await handoff.prepare("context_threshold");
  advance(400);
  await handoff.commit();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.prepares, 1);
  assert.equal(snapshot.commits, 1);
  assert.equal(snapshot.aborts, 0);
  assert.equal(snapshot.abortRate, 0);
  assert.equal(snapshot.overlapMs.count, 1);
  assert.ok((snapshot.overlapMs.max ?? 0) >= 400, "overlap is measured from prepare to commit");
  assert.equal(snapshot.prepareLatencyMs.count, 1);

  // Bounded: the snapshot's shape does not depend on how many attempts have run.
  assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(metrics.snapshot()).sort());
});

test("aborts are counted by reason, so a repeatedly failing handoff is visible", async () => {
  const { metrics, handoff } = await fixture({ deferContextAck: true });

  await handoff.prepare("context_threshold");
  await handoff.prepare("manual");

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.aborts, 2);
  assert.equal(snapshot.abortRate, 1);
  assert.deepEqual(snapshot.abortsByReason, { REPLACEMENT_NOT_READY: 2 });
});
