# ADR 0002: A delegated result enters as runtime context, never as something the user said

- **Status:** Accepted
- **Date:** 2026-08-15
- **Decision owners:** M.A.R.K. II architecture
- **Retroactive:** records a decision already implemented in
  `src/delegation/delivery.ts`

## Context

A delegated execution finishes after the turn that requested it has ended. Its
result has to re-enter a live conversation, and the only channel a realtime
session offers is the one carrying conversation content.

The path of least resistance is to inject the result as a user turn. It works
immediately: the model sees text, responds to it, the answer reaches the user. It
also makes the system unable to distinguish what the user asked from what the
runtime found — in the live session, in the episode record, and in every trace
afterwards. A later extraction pass reading that episode would attribute the
runtime's findings to the user as things they said.

Delivery timing is a second decision hiding inside the first. A result that
arrives mid-sentence and interrupts is right for an urgent answer and wrong for a
background lookup, and the correct choice is not a property of the result.

## Decision

**A background result is never replayed as something the user said.** It travels
as a context event with `source: "delegation"`, so the voice model and every trace
afterwards can tell the difference between what the user asked and what the
runtime found.

**Delivery scheduling is an explicit policy, not a preference:**

| Policy | Behaviour |
| --- | --- |
| `interrupt` | Cuts the current answer off |
| `when_idle` | Waits for a gap |
| `silent` | Never speaks; the result is recorded, not delivered |

**Delivery binds to `logicalSessionId`, not to the physical session.** A physical
id changes at every handoff commit, and every queued delegation keyed to it would
be stranded at the moment the session was replaced.

## Rejected alternatives

### Inject the result as a user turn

Rejected. It is the simplest thing that works and it destroys the distinction
between what the user said and what the runtime found — permanently, because the
episode record keeps the wrong attribution.

### Inject as an assistant turn

Rejected. Better attribution, still wrong: it asserts the assistant already said
something it did not say, and the model then treats fabricated history as its own
prior commitment.

### Always interrupt, since the user asked for it

Rejected. The user asked for the answer, not for the answer to arrive over the top
of whatever they are hearing. Urgency is a property of the request, so it is
declared per delegation.

### Key delivery to the physical session

Rejected. It is correct until the first handoff and silently loses every queued
result after it — the worst failure shape, because it works in testing.

## Consequences

### Positive

- Episode records attribute correctly, so later extraction cannot turn a runtime
  finding into a user statement.
- Timing is chosen per delegation by the party that knows the urgency.
- Results survive a session handoff.

### Costs

- The consumer must handle a context event source it would otherwise ignore.
- `silent` results are invisible unless something reads the trace.
- Logical and physical session identity must both be tracked and not confused.

## Enforced in

- `src/delegation/delivery.ts`
- `src/delegation/broker.ts`
- `src/handoff/composition.ts`

## Explicit non-decisions

This ADR does not decide which delivery policy any capability should use, does not
define the idle threshold for `when_idle`, does not govern how a handoff commits —
see `src/handoff/` — and does not authorize a delegated result to perform an action
on arrival.
