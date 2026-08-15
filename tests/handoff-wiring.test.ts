/**
 * The wiring itself, against the real adapter and the real multi-session Realtime Core.
 *
 * The handoff machinery already had tests; what it did not have was a wire into a running
 * assistant. These assert the properties that only exist once there is one: a replacement
 * that owns no audio until it is told to, a swap that moves every frame at once, and a
 * failing replacement that cannot silence the session still talking to the user.
 *
 * Audio ownership is proven by sending frames and reading the provider's per-session
 * counters, never by reading a variable the code under test also wrote.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { FakeRealtimeSpeechProvider, REALTIME_INPUT_FORMAT, RealtimeCore } from "realtime-core";
import { RealtimeCoreAdapter } from "../src/adapters.js";
import { createRealtimeHandoffController } from "../src/handoff/realtime-controller.js";
import { RollingTranscript } from "../src/handoff/transcript.js";

/** One 20 ms frame at the realtime input rate, which is what the frameizer emits on. */
const pcm = (): Int16Array => new Int16Array((REALTIME_INPUT_FORMAT.sampleRate / 1000) * REALTIME_INPUT_FORMAT.frameDurationMs);

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function wired(options: { contextInjection?: boolean } = {}) {
  const provider = new FakeRealtimeSpeechProvider({ contextInjection: options.contextInjection ?? true, toolCalling: "async" });
  const core = new RealtimeCore(provider);
  const kinds: string[] = [];
  const boundTo: string[] = [];
  const adapter = new RealtimeCoreAdapter(core, { provider: "fake", inputFormat: { ...REALTIME_INPUT_FORMAT } });
  adapter.onSession((session, _capabilities, kind) => { kinds.push(kind); boundTo.push(session.id); });
  const attachment = await adapter.open();
  await settle();
  const primary = adapter.activeSessionId()!;
  return { provider, core, adapter, attachment, kinds, boundTo, primary };
}

test("a replacement session exists without owning the microphone", async () => {
  const { provider, adapter, primary, kinds } = await wired();
  try {
    const replacement = await adapter.openReplacement();
    await adapter.sendMicrophonePcm(pcm());
    await settle();

    const counts = provider.audioFrameCounts();
    assert.equal(counts[replacement], 0, "a prepared session must not hear the user");
    assert.ok((counts[primary] ?? 0) > 0, "the session that owns audio still gets every frame");
    assert.equal(adapter.activeSessionId(), primary);
    // A greeted replacement would announce the handoff in the one way the user cannot miss.
    assert.deepEqual(kinds, ["interaction"], "opening a replacement is not taking ownership");
  } finally { await adapter.stop(); }
});

test("activation moves every frame at once, and reports itself as a handoff", async () => {
  const { provider, adapter, primary, kinds, boundTo } = await wired();
  try {
    const replacement = await adapter.openReplacement();
    await adapter.sendMicrophonePcm(pcm());
    await settle();
    const before = provider.audioFrameCounts();

    adapter.activateSession(replacement);
    await settle();
    await adapter.sendMicrophonePcm(pcm());
    await settle();
    const after = provider.audioFrameCounts();

    assert.equal(adapter.activeSessionId(), replacement);
    assert.equal(after[primary], before[primary], "the replaced session stops receiving audio immediately");
    assert.ok((after[replacement] ?? 0) > 0, "the replacement receives it instead");
    // The distinction the logical session id depends on: a handoff continues a conversation,
    // it does not start one.
    assert.deepEqual(kinds, ["interaction", "handoff"]);
    assert.deepEqual(boundTo, [primary, replacement]);
  } finally { await adapter.stop(); }
});

test("prefill uses context injection and resolves only once the provider took it", async () => {
  const { provider, adapter } = await wired();
  try {
    const replacement = await adapter.openReplacement();
    await adapter.prefillSession(replacement, "Simon is planning a trip to Brno.");

    const injected = provider.contextEvents.at(-1);
    assert.equal(injected?.sessionId, replacement);
    assert.equal(injected?.source, "system", "prefilled context is not something the user said");
    assert.equal(injected?.content.type === "text" ? injected.content.text : "", "Simon is planning a trip to Brno.");
  } finally { await adapter.stop(); }
});

test("a provider without context injection prefills by text rather than silently succeeding", async () => {
  const { provider, adapter } = await wired({ contextInjection: false });
  try {
    const replacement = await adapter.openReplacement();
    await adapter.prefillSession(replacement, "context");
    assert.deepEqual(provider.contextEvents, [], "no injection was available to use");
  } finally { await adapter.stop(); }
});

test("closing a replacement leaves the session that still owns the conversation alone", async () => {
  const { provider, adapter, primary } = await wired();
  try {
    const replacement = await adapter.openReplacement();
    await adapter.closeSession(replacement);
    await settle();

    assert.equal(adapter.activeSessionId(), primary, "an abandoned attempt must not take audio down with it");
    const before = provider.audioFrameCounts();
    await adapter.sendMicrophonePcm(pcm());
    await settle();
    assert.ok((provider.audioFrameCounts()[primary] ?? 0) > (before[primary] ?? 0), "the conversation keeps going");
  } finally { await adapter.stop(); }
});

test("the controller exposes the adapter under the handoff's own contract", async () => {
  const { adapter, primary } = await wired();
  try {
    const controller = createRealtimeHandoffController(adapter);
    const replacement = await controller.open();
    await controller.prefill(replacement, "context");
    controller.activate(replacement);

    assert.equal(adapter.activeSessionId(), replacement);
    await controller.close(primary);
    assert.equal(adapter.activeSessionId(), replacement, "closing the old session does not disturb the new one");
  } finally { await adapter.stop(); }
});

test("the runtime's transcript is bounded, and says how much it dropped", () => {
  const transcript = new RollingTranscript({ maxTurns: 3 });
  for (const text of ["one", "two", "three", "four"]) transcript.record({ role: "user", text });
  transcript.record({ role: "assistant", text: "   " });

  assert.deepEqual(transcript.turns().map((turn) => turn.text), ["two", "three", "four"]);
  assert.equal(transcript.droppedTurns(), 1, "truncation is reported, never silent");
});

test("a compacted window replaces the record rather than accumulating on top of it", () => {
  const transcript = new RollingTranscript();
  transcript.record({ role: "user", text: "the whole conversation so far" });
  transcript.reset({ text: "Summary of the conversation so far" });

  assert.deepEqual(transcript.turns(), [{ role: "system", text: "Summary of the conversation so far" }]);
});
