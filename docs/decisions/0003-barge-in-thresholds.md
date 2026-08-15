# ADR 0003: The barge-in gate measures echo before it trusts itself

- **Status:** Accepted
- **Date:** 2026-08-15
- **Decision owners:** M.A.R.K. II architecture
- **Retroactive:** records a decision already implemented in
  `src/echo-cancellation.ts`

## Context

Barge-in — letting the user interrupt the assistant mid-sentence — requires
deciding, from the microphone signal, whether incoming sound is the user speaking
or the assistant's own voice returning through the room.

Two failure modes sit on either side of that threshold, and both are bad in a way
that is hard to diagnose from a log:

- **Too low.** The assistant hears itself, decides it is being interrupted, and
  stops. On a microphone whose echo is louder than the noise floor this happens
  immediately and repeatedly, and it presents as an assistant that cannot finish a
  sentence.
- **Too high.** The user cannot interrupt at all, which is the feature not
  existing.

The threshold cannot be a constant, because it depends on the room, the speaker
volume, and the microphone. It has to be measured. But at the instant the session
starts nothing has been measured yet, and that is exactly when the assistant first
speaks.

## Decision

Three rules, each answering one of the above:

**A measured echo level with a slow decay.** `ECHO_PEAK_DECAY = 0.999` — roughly a
14-second half-life at 20 ms frames. Slow on purpose: a fast decay would let a
single quiet moment drop the threshold while the assistant is still speaking. Slow
enough that one loud burst of echo does not hold the threshold up for the rest of
the conversation.

**An absolute floor.** `MINIMUM_BARGE_IN_LEVEL = 0.02`. No sound below this is ever
an interruption, whatever the echo estimate says.

**A warm-up before barge-in is allowed at all.** Half a second of suppressed frames
must be observed first. Until the echo has been measured the threshold is only the
floor, and on a microphone whose echo is louder than the floor that would admit the
echo itself. The warm-up costs a barge-in nobody has attempted yet and prevents the
gate unlocking itself with the assistant's own voice.

## Rejected alternatives

### A fixed threshold

Rejected. It is either too low for a loud room or too high for a quiet one, and no
single value is right for two different microphones.

### Trust the echo estimate from the first frame

Rejected. It is the case the warm-up exists for: with nothing measured, the
threshold is the floor, and echo above the floor unlocks the gate with the
assistant's own voice.

### Fast decay, so the threshold tracks the room closely

Rejected. It drops the threshold during the natural pauses inside the assistant's
own speech, which is precisely when the next syllable of echo arrives.

### Suppress barge-in entirely while the assistant is speaking

Rejected. That is not barge-in; it is turn-taking with extra steps, and it makes
the assistant impossible to stop.

## Consequences

### Positive

- The gate adapts to the room instead of to a guess.
- It cannot unlock itself with the assistant's own voice.
- The first half-second is the only period where barge-in is unavailable.

### Costs

- The constants are empirical, tuned against real hardware, and have no derivation.
- A user interrupting within the first half second is not heard.
- Behaviour differs between microphones in ways only hardware testing reveals.

## Enforced in

- `src/echo-cancellation.ts`

## Explicit non-decisions

This ADR does not govern the echo-cancellation algorithms themselves — those are
`aec-system`'s — does not decide what happens after a barge-in is detected, and
does not fix these constants for any other host or microphone.
