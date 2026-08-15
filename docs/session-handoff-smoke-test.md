# Session handoff smoke test

Manual, hardware-and-provider evidence for session handoff and live context
compaction. A green deterministic suite is **not** evidence for anything on this
page: the fake provider proves the lifecycle, not that a Gemini session prefills
in time, not that a room's echo canceller re-converges on a new playback path,
and not that a cutover is inaudible to a person.

> **This test is now runnable.** The wiring landed on `feat/handoff-wiring`:
> `composition.ts` builds the assembly per interaction, feeds the estimator from
> the realtime event stream, and binds delegation delivery to a logical session
> id. Nothing on this page has been run yet — every UNVERIFIED row below is still
> UNVERIFIED, and the procedure is unchanged from when it was written, which is
> the point of having written it in advance.

## What is already proven without hardware

| Claim | Evidence | State |
| --- | --- | --- |
| Lifecycle, idempotent commit, every abort path | `assistant-runtime` — `tests/handoff-lifecycle.test.ts` | VERIFIED offline |
| Exactly one session owns audio, on every path including aborts | `tests/handoff-audio-ownership.test.ts` | VERIFIED offline |
| Trigger fires once, early enough, never below threshold | `tests/handoff-trigger.test.ts` | VERIFIED offline |
| Live session keeps taking audio for the whole compaction | `tests/handoff-compaction.test.ts` | VERIFIED offline |
| No cutover mid-speech in either direction; deadline abort | `tests/handoff-idle-cutover.test.ts` | VERIFIED offline |
| Status published; echo reference rebound on commit only | `tests/handoff-observability.test.ts` | VERIFIED offline |
| Logical id stable; delegation spanning the swap delivered | `tests/handoff-correlation.test.ts` | VERIFIED offline |
| Disconnect and shutdown in every phase leave one session | `tests/handoff-resilience.test.ts` | VERIFIED offline |
| Multi-session Realtime Core | `speech-system/realtime core` — `tests/multi-session.test.ts` | VERIFIED offline |
| Export/import round trip, including legacy v1 | `memory-core` — `tests/integration/import-export.test.ts` | VERIFIED offline |
| A Gemini session accepts prefilled context and continues coherently | — | **UNVERIFIED** |
| Prefill completes inside `readyTimeoutMs` against a live provider | — | **UNVERIFIED** |
| A cutover is inaudible to a person | — | **UNVERIFIED** |
| Echo cancellation re-converges on the new playback path | — | **UNVERIFIED** |

The four unverified rows are the entire purpose of this test.

---

## Prerequisite zero — the baseline, before anything else

**The delivery-rebinding change affects the live path whether `handoff.enabled`
is true or false.** Delegation delivery is now keyed to a logical session id
rather than `session.id`, and that code runs on every conversation.

So: with `handoff.enabled: false`, re-run [the baseline hardware smoke
test](./hardware-smoke-test.md) and [the delegated voice smoke
test](./delegated-voice-smoke-test.md) *first*. If either regresses, stop — you
are no longer testing handoff, you are testing a broken conversation, and the
finding is in the rebinding rather than in anything below.

Only once both pass unchanged does turning `handoff.enabled` on mean anything.

### Trace events that tell you the wiring is live

Before a handoff can be measured, confirm it is actually connected. On startup
and on the first interaction you should see:

- `handoff.session.started` with a `logicalSessionId` and `enabled: true`. If it
  says `enabled: false`, check `handoff.disabled` — delegation off is the usual
  reason, because compaction runs through the broker.
- `delegation.session.bound` carrying **both** `sessionId` (logical) and
  `physicalSessionId`, with `kind: "interaction"`.

Then, during an attempt: `realtime.replacement.opened` →
`realtime.prefill.acknowledged` → `realtime.session.activated` →
`delegation.session.bound` again, this time with `kind: "handoff"`, the **same**
logical `sessionId`, and a different `physicalSessionId`. That last line is the
one worth staring at: it is the whole reason the wiring was possible.

A `realtime.prefill.degraded` line means the provider advertised no context
injection and the summary went in as text. Not a failure, but record it — it
changes what the replacement was actually given.

---

## Prerequisites

- `GEMINI_API_KEY` in the environment or `.env` beside the config.
- A working microphone and speaker, echo cancellation configured as you normally
  run it. Do not switch to a headset for this test: the Bluetooth-speaker case is
  where the canceller is already known to be marginal, and it is the case the
  cutover is most likely to break.
- `delegation.enabled: true`. Compaction runs through the broker, so a runtime
  with delegation off cannot compact.
- A `usage.priceCatalog` entry for the compaction model, or an
  `unknownCostPolicy` you accept. Compaction is metered under its own role;
  a `block` policy with no entry will refuse the call and abort the handoff.
- Traces captured to a file. Most of what this test measures is not audible.

### Forcing a handoff in minutes instead of an hour

At the shipped defaults a handoff needs roughly 128k tokens of conversation.
That is not a test, it is an afternoon. Lower the limit so the threshold trips
after a couple of minutes of talking:

```json
"handoff": {
  "enabled": true,
  "contextLimitTokens": 2000,
  "prepareThreshold": 0.7,
  "readyTimeoutMs": 20000,
  "idleWaitTimeoutMs": 30000
}
```

At the estimator's 32 tokens/second audio rate, 70% of 2000 is about 44 seconds
of speech. **Do not lower `readyTimeoutMs` to match.** The point is to reach the
threshold quickly while leaving the provider its real prefill budget — shortening
both would manufacture an abort and prove nothing.

Record the values you used. A handoff verified at a 2000-token limit is evidence
for the mechanism, not for the shipped threshold.

### Turn on the recording you will need to measure with

```json
"echoCancellation": { "recordDir": "..\\.runtime\\handoff-audio" }
```

This writes the played, captured, and cleaned streams as headerless
`pcm_s16le`. It is off by default because it records the user's microphone to
disk. Turn it off again afterwards, and delete the files when you are done.

---

## Procedure

1. Start the assistant with the configuration above and traces to a file.
2. **Plant a fact the replacement cannot know unless compaction carried it.**
   Early in the conversation say something specific and arbitrary — a name, a
   number, a colour. *"Jmenuji se Šimon a moje šťastné číslo je čtyřicet dva."*
   Note the wall-clock time.
3. **Talk continuously** for roughly a minute. Content does not matter; duration
   does. Watch the trace for `handoff.prepared`.
4. **Keep talking through the prepare.** This is the whole feature: the
   conversation must not pause while a replacement is opened and compacted. If
   the assistant stops responding here, stop the test and record it.
5. Let a natural gap fall — finish a sentence and stay quiet. Watch for
   `handoff.ready` then `handoff.committed`.
6. **Immediately ask the planted question.** *"Jaké je moje šťastné číslo?"*
   Note the latency from the end of your utterance to the first audible word.
7. **Barge in on the answer.** Interrupt mid-sentence. This is the echo
   cancellation check, and it is the one most likely to fail.
8. Ask a follow-up that depends on something said *before* the handoff but which
   you did not plant explicitly. You are testing whether the summary is usable,
   not just whether one fact survived.
9. Let the conversation end normally and confirm memory extraction still ran.

### The adversarial variant, once the happy path passes

Run it again and **speak across the intended cutover point** — start talking the
instant you see `handoff.ready`. The commit must wait. If you are cut off
mid-word, that is a defect in the re-check, not a cosmetic issue.

---

## How to measure "no audible gap" — do not trust your ears

The cutover happens *in* a gap by design, so there is already silence around it.
Measuring silence during the swap proves nothing. Two things actually matter:

**Response latency of the next turn.** Compare step 6's latency against a normal
turn from earlier in the same run. A handoff that adds a second before the
assistant speaks again is audible as hesitation even though no audio was lost.
Take the timings from the trace, not from a stopwatch.

**Continuity of the playback stream.** In `handoff-audio/`, the reference stream
is what was played. At 24 kHz mono `s16le`, one second is 48 000 bytes. Locate
the commit by its timestamp and confirm the stream is contiguous across it —
that no partial utterance was truncated by the teardown. A cut mid-word is the
failure the test exists to catch, and it will be visible in the waveform whether
or not you noticed it live.

---

## What to record

Copy these from the trace, not from memory:

- **Event order:** `handoff.prepared` → `compaction.started` →
  `compaction.completed` → `handoff.ready` → `handoff.committed`. Any other
  order, or a missing event, is the finding.
- **Prepare latency** (`prepared` → `ready`) and **wait-for-idle**
  (`ready` → `committed`), from `handoff.metrics`. Compare prepare latency
  against `readyTimeoutMs`: if it is anywhere near it, the shipped threshold has
  less margin than the offline test asserts.
- **Overlap duration**, and therefore what you were billed twice for.
- **The logical session id before and after the commit.** It must not change.
  The physical ids must.
- **Whether any delegation spanned the commit**, and whether its result was
  delivered or dropped.
- **State Core**: `assistant.session.handoff_state` going
  `handoff_pending` → `handoff_active` → `idle`.
- **Compaction cost**, metered under role `compaction`, separately from `voice`
  and `delegation`. Confirm all three appear.
- **The compacted summary itself.** Read it. This is the only opportunity to see
  what compaction actually decided to keep, and whether it dropped something you
  would have wanted.
- **AEC metrics after the commit**: ERLE, and whether the processor fell back to
  the gate. Compare against the same numbers from before the handoff.

---

## Failure modes worth distinguishing

- **No `handoff.prepared` at all.** The estimator is not being fed. Check that
  the realtime event handler calls `record` / `recordAudio` — an unfed estimator
  reads zero forever and looks exactly like a conversation that never grew.
- **`handoff.aborted` with `REPLACEMENT_NOT_READY`.** The provider did not
  acknowledge the prefill in time. Record the actual prefill duration before
  raising the timeout; if it is wildly over, the compacted context may be too
  large rather than the timeout too short.
- **`handoff.aborted` with `NO_IDLE_GAP`.** Either you never stopped talking, or
  idle detection is not receiving output events. Check whether
  `markOutputFinished` fires at all.
- **`compaction.failed`.** Read the code. An unpriced model under a `block`
  policy fails here and looks like a model failure.
- **The replacement answers as if the conversation just began.** Compaction
  produced something unusable, or the prefill did not land. The summary is in the
  trace — read it before blaming the provider.
- **The assistant starts answering itself.** Echo cancellation did not re-converge
  on the new playback path. This is the most serious possible outcome and the
  least obvious: every event in the trace will say success. If you see the
  assistant respond to its own last sentence, stop and record it.
- **Barge-in stops working after the cutover but not before.** The same defect,
  caught earlier. The canceller is suppressing everything because it no longer
  recognises the reference.
- **Two voices, or audio from both sessions.** A contract violation. Stop the
  test and report it — the offline suite asserts this cannot happen, so a live
  occurrence means the wiring bypassed the controller.

---

## After the run

Record the outcome in `assistant-runtime/PROGRESS.md` and in
`CHANGELOG-session-handoff.md` as VERIFIED, DEGRADED, or UNVERIFIED — with the
date, the model names, **and the `contextLimitTokens` you used**. A pass at a
lowered limit does not verify the shipped threshold; say which one you tested.

Then put the configuration back: restore `contextLimitTokens`, remove
`recordDir`, and delete the recorded audio.

Do not promote an offline pass to a hardware claim. Do not leave a degraded run
recorded as a verified one. If echo cancellation across a cutover is anything
less than clean, `handoff.enabled` should go back to `false` until it is — a
conversation that survives its context limit by answering itself is worse than
one that ends.
