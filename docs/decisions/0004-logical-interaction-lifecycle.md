# ADR 0004: A physical realtime session cannot end a logical interaction

- **Status:** Accepted
- **Date:** 2026-08-16
- **Decision owners:** M.A.R.K. II architecture
- **Retroactive:** records the lifecycle correction exposed by the first live handoff run

## Context

Session handoff deliberately closes the old physical realtime session after a
replacement has been prefetched and activated. The user interaction must remain
alive across that replacement: the logical conversation, episode, delegation
delivery binding, inactivity timer, and activation guard all outlive one
provider transport.

The first Windows/Gemini handoff run exposed the opposite interpretation. The
runtime awaited `done` from the initial physical session. Handoff closed that
session, the runtime marked the whole interaction finished, and a later
activation opened a new logical conversation and spoke the initial greeting
again. The result was two episode closes and a visible restart immediately after
an otherwise successful handoff.

## Decision

The handle returned by `RealtimeCoreAdapter.open()` represents the logical
interaction, not the first physical session.

- Its `done` promise resolves only when the currently active physical session
  ends, the logical handle is explicitly closed, or the adapter shuts down.
- Closing a superseded physical session during handoff must not resolve `done`.
- The logical `close()` closes every physical session still attached to that
  interaction, including the replacement, and then resolves `done`.
- `openReplacement()` and `closeSession()` remain physical operations owned by
  the handoff controller; they must not be used as the runtime's logical close.

## Rejected alternatives

### Ignore activation events while a handoff is in progress

Rejected. The runtime had already lost its `current` interaction, so this would
patch one symptom while leaving the lifecycle contract wrong. It would also
make genuine provider/session loss difficult to distinguish from a handoff.

### Keep the old physical session open until the conversation ends

Rejected. Handoff needs to transfer ownership and close the superseded
transport; keeping it open would violate the one-session-audio ownership rule
and waste provider resources.

### Teach Realtime Core about logical handoff lifecycle

Rejected. Realtime Core owns physical provider sessions and deliberately has no
handoff vocabulary. Assistant Runtime owns the translation between physical
transport lifecycle and logical conversation lifecycle.

## Consequences

### Positive

- A physical cutover cannot trigger a new greeting or a second logical episode.
- Runtime inactivity and cancellation continue to target the active replacement.
- Provider session closure remains observable without being misclassified as
  conversation closure.
- The contract is protected by a real multi-session regression test.

### Costs

- The adapter maintains one logical lifecycle alongside its physical-session
  attachments.
- Callers must distinguish the handoff controller's physical close from the
  runtime handle's logical close.

## Enforced in

- `src/adapters.ts`
- `src/runtime.ts`
- `tests/handoff-wiring.test.ts`

## Explicit non-decisions

This ADR does not claim that echo cancellation, barge-in, prefill latency, or
inaudible cutover are verified on hardware. It also does not change activation
detection thresholds or decide whether a provider should reconnect after an
unrelated transport failure.
