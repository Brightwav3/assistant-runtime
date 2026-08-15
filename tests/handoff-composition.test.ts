/**
 * The whole assembly, driven end to end against the fake provider.
 *
 * Each part has its own test; this one exists because the parts have to agree. The
 * estimator reset in particular is only correct if it is seeded with what the replacement
 * was *actually* prefilled with, and no single-component test can see that.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AcceptedExecution, IntelligenceRequest, IntelligenceResult } from "intelligence-core";
import { RuntimeDelegationBroker } from "../src/delegation/broker.js";
import { DelegationDeliveryScheduler } from "../src/delegation/delivery.js";
import { createHandoffComposition } from "../src/handoff/composition.js";
import { HANDOFF_STATE_KEYS } from "../src/handoff/state-publisher.js";
import type { HandoffEvent } from "../src/handoff/contracts.js";
import type { DelegationStructuredResult } from "../src/contracts.js";
import { createHarness } from "./handoff-harness.js";

const SUMMARY: DelegationStructuredResult = {
  schema: "delegation.result.v1",
  summary: "Simon is planning a trip to Brno on Friday.",
  data: { retained_facts: ["The user is called Simon."], source_turn_count: 40 },
  references: [],
};

/** Answers immediately, so the assembly is driven by its own logic rather than by timing. */
class InstantIntelligence {
  public accept(_request: IntelligenceRequest): AcceptedExecution {
    const result: IntelligenceResult = {
      request_id: "req-1",
      execution_id: "exec-1",
      status: "completed",
      outputs: [{ type: "structured", value: SUMMARY as unknown as Record<string, unknown> }],
      usage: { duration_ms: 1, model_calls: 1, tool_calls: 0 },
    };
    return { executionId: "exec-1", record: () => undefined, result: Promise.resolve(result), cancel: async () => undefined };
  }
}

class RecordingState {
  public readonly writes: Array<{ key: string; value: string | boolean }> = [];
  public async set(input: { key: string; value: string | boolean; source: { sourceType: "system"; sourceId: string } }): Promise<unknown> {
    this.writes.push({ key: input.key, value: input.value });
    return input;
  }
  public latest(key: string): string | boolean | undefined { return [...this.writes].reverse().find((write) => write.key === key)?.value; }
}

async function assembly(enabled = true) {
  const harness = await createHarness();
  const scheduler = new DelegationDeliveryScheduler();
  const state = new RecordingState();
  const rebound: string[] = [];
  const events: HandoffEvent[] = [];

  const composition = createHandoffComposition({
    settings: { enabled, contextLimitTokens: 10_000, prepareThreshold: 0.7, readyTimeoutMs: 10_000, idleWaitTimeoutMs: 10_000 },
    assistantId: "assistant.primary",
    logicalSessionId: "logical-1",
    activePhysicalSessionId: harness.initialSessionId,
    controller: harness.controller,
    broker: new RuntimeDelegationBroker({ intelligence: new InstantIntelligence() }),
    transcript: { turns: () => [{ role: "user", text: "hello" }] },
    model: { provider: "gemini", model: "gemini-3.5-flash-lite", fallbackModels: [] },
    compactionDeadlineMs: 30_000,
    output: scheduler,
    state,
    echo: { beginSession: (id) => rebound.push(id) },
    trace: (event) => events.push(event),
  });

  return { harness, scheduler, state, rebound, events, composition };
}

test("a full attempt runs from threshold to committed replacement", async () => {
  const { harness, state, rebound, composition } = await assembly();

  // Push the window past the threshold the way a conversation would.
  while (!composition.maybePrepare()) composition.estimator.recordAudio({ durationMs: 10_000 });

  await composition.run();

  assert.equal(composition.coordinator.phase(), "idle");
  assert.notEqual(harness.activeSessionId(), harness.initialSessionId, "the replacement owns the conversation");
  assert.deepEqual(harness.openSessionIds(), [harness.activeSessionId()], "the previous session is closed");
  assert.equal(state.latest(HANDOFF_STATE_KEYS.status), "idle");
  assert.deepEqual(rebound, [harness.activeSessionId()], "echo follows the playback path");
  assert.equal(composition.metrics.snapshot().commits, 1);
  await harness.speak();
});

test("the new window is seeded with what the replacement was actually prefilled with", async () => {
  const { composition } = await assembly();

  while (!composition.maybePrepare()) composition.estimator.recordAudio({ durationMs: 10_000 });
  const before = composition.estimator.estimate().tokens;

  await composition.run();
  const after = composition.estimator.estimate().tokens;

  assert.ok(after > 0, "the replacement did not start from nothing");
  assert.ok(after < before / 5, "a handoff that does not buy headroom has not bought anything");
  assert.equal(composition.trigger.isArmed(), true, "the trigger is re-armed for the next window");
});

test("the trigger does not fire at all while handoff is disabled", async () => {
  const { harness, composition } = await assembly(false);

  for (let turn = 0; turn < 100; turn += 1) {
    composition.estimator.recordAudio({ durationMs: 10_000 });
    assert.equal(composition.maybePrepare(), false);
  }

  assert.deepEqual(harness.openSessionIds(), [harness.initialSessionId]);
});

test("the assembly waits for a gap before swapping", async () => {
  const { harness, scheduler, composition, events } = await assembly();
  scheduler.markOutputStarted("logical-1");

  while (!composition.maybePrepare()) composition.estimator.recordAudio({ durationMs: 10_000 });
  const attempt = composition.run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.some((event) => event.type === "handoff.ready"), true);
  assert.equal(events.some((event) => event.type === "handoff.committed"), false, "no cutover mid-sentence");
  assert.equal(harness.activeSessionId(), harness.initialSessionId);

  await scheduler.markOutputFinished("logical-1");
  await attempt;

  assert.equal(events.some((event) => event.type === "handoff.committed"), true);
  composition.dispose();
});
