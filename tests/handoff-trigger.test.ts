/**
 * The trigger has to fire early enough to be useful and rarely enough to be safe.
 *
 * Both halves are failure modes with the same symptom in a demo — nothing visibly wrong —
 * and opposite consequences in a long conversation. A trigger that fires late leaves no
 * room to prefill; a trigger that fires on every turn opens replacement sessions for the
 * rest of the session.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeSettings } from "../src/config.js";
import { ContextThresholdTrigger, RuntimeContextEstimator } from "../src/handoff/context-estimator.js";

const LIMIT = 128_000;
const THRESHOLD = 0.7;
const READY_TIMEOUT_MS = 20_000;
const AUDIO_TOKENS_PER_SECOND = 32;

const estimator = (limit = LIMIT) => new RuntimeContextEstimator({ limitTokens: limit });

test("audio counts toward the estimate, because a voice conversation is mostly audio", () => {
  const context = estimator();
  context.recordAudio({ durationMs: 60_000 });

  assert.equal(context.estimate().tokens, 60 * AUDIO_TOKENS_PER_SECOND);
  assert.ok(context.estimate().ratio > 0, "a minute of speech must not read as an empty window");
});

test("the estimate errs high rather than low", () => {
  const context = estimator();
  // 300 characters is roughly 75 tokens by a real tokenizer's ~4 characters per token.
  context.record({ role: "user", text: "x".repeat(300) });

  assert.ok(context.estimate().tokens > 75, "under-estimating context is the unrecoverable direction");
});

test("crossing the threshold fires exactly once, not once per turn", () => {
  const context = estimator();
  const trigger = new ContextThresholdTrigger(context, THRESHOLD);

  let fired = 0;
  for (let turn = 0; turn < 200; turn += 1) {
    context.recordAudio({ durationMs: 30_000 });
    if (trigger.observe()) fired += 1;
  }

  assert.equal(fired, 1);
  assert.equal(trigger.isArmed(), false);
});

test("a conversation that plateaus below the threshold never triggers", () => {
  const context = estimator();
  const trigger = new ContextThresholdTrigger(context, THRESHOLD);

  // Half the window, then nothing but short turns.
  context.recordAudio({ durationMs: (LIMIT * 0.5 / AUDIO_TOKENS_PER_SECOND) * 1000 });
  for (let turn = 0; turn < 100; turn += 1) {
    context.record({ role: "user", text: "yes" });
    assert.equal(trigger.observe(), false);
  }

  assert.ok(context.estimate().ratio < THRESHOLD);
  assert.equal(trigger.isArmed(), true);
});

test("the headroom left at the threshold outlasts a full ready timeout of speech", () => {
  const context = estimator();
  const trigger = new ContextThresholdTrigger(context, THRESHOLD);

  while (!trigger.observe()) context.recordAudio({ durationMs: 1_000 });

  const headroom = context.headroomTokens();
  const spentWhileWaiting = (READY_TIMEOUT_MS / 1000) * AUDIO_TOKENS_PER_SECOND;

  // Not "greater than" — a margin. Prefill latency is measured in seconds, but the
  // conversation does not stop while it happens, and a threshold change that leaves only a
  // hair of room should fail here rather than in a live session.
  assert.ok(
    headroom > spentWhileWaiting * 10,
    `headroom ${headroom} must comfortably exceed the ${spentWhileWaiting} tokens a ready timeout of speech costs`,
  );
});

test("reset seeds the new window with the compacted context and re-arms the trigger", () => {
  const context = estimator();
  const trigger = new ContextThresholdTrigger(context, THRESHOLD);

  while (!trigger.observe()) context.recordAudio({ durationMs: 5_000 });
  const before = context.estimate().tokens;

  context.reset({ text: "a two hundred character summary of everything said so far.".repeat(4) });
  trigger.rearm();

  const after = context.estimate().tokens;
  assert.ok(after > 0, "the replacement starts with the compacted context, not with nothing");
  assert.ok(after < before / 10, "a handoff that does not buy headroom has not bought anything");
  assert.equal(trigger.isArmed(), true);
  assert.equal(trigger.observe(), false);
});

test("a threshold outside (0, 1) is refused rather than silently clamped", () => {
  assert.throws(() => new ContextThresholdTrigger(estimator(), 1));
  assert.throws(() => new ContextThresholdTrigger(estimator(), 0));
  assert.throws(() => new RuntimeContextEstimator({ limitTokens: 0 }));
});

test("handoff configuration defaults are present and a threshold at the limit is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-handoff-config-"));
  const file = join(directory, "config.json");
  try {
    await writeFile(file, JSON.stringify({}), "utf8");
    const settings = await loadRuntimeSettings(file);
    assert.equal(settings.handoff.enabled, false, "handoff stays off until it is asked for");
    assert.equal(settings.handoff.prepareThreshold, THRESHOLD);
    assert.equal(settings.handoff.contextLimitTokens, LIMIT);
    assert.equal(settings.handoff.readyTimeoutMs, READY_TIMEOUT_MS);

    // Preparing at the limit is preparing too late, so it is a configuration error.
    await writeFile(file, JSON.stringify({ handoff: { prepareThreshold: 1 } }), "utf8");
    await assert.rejects(() => loadRuntimeSettings(file), /prepareThreshold/);

    await writeFile(file, JSON.stringify({ handoff: { contextLimitTokens: 0 } }), "utf8");
    await assert.rejects(() => loadRuntimeSettings(file), /contextLimitTokens/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
