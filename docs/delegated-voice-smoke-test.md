# Delegated voice smoke test

Manual, hardware-and-provider evidence for delegated voice intelligence. A green
deterministic test suite is **not** evidence for anything on this page: the fake
providers prove the contract, not Czech speech recognition, not a real Gemini
session, and not a speaker.

## What is already proven without hardware

| Claim | Evidence | State |
| --- | --- | --- |
| Delegation contract, capability negotiation, degraded fallback | `speech-system/realtime core` — `tests/delegation-contracts.test.ts` | VERIFIED offline |
| Bounded recall, scope, provenance, forgotten records | `memory-core` — `tests/unit/delegated-recall.test.ts` | VERIFIED offline |
| Immediate acceptance, deadlines, cancellation | `intelligence-core` — `tests/integration/accepted-execution.test.ts` | VERIFIED offline |
| Normalized usage, retries, unknown-cost policy, forecasts | `intelligence-core` + `assistant-runtime` usage tests | VERIFIED offline |
| Broker lifecycle, delivery scheduling, late results | `assistant-runtime` — `tests/delegation-*.test.ts` | VERIFIED offline |
| MIT / Mars / submarine disambiguation end to end | `assistant-runtime` — `tests/robot-memory-delegation.test.ts` | VERIFIED offline, fake providers |
| Gemini `sendClientContent` accepts turns on an open session | `@google/genai` 1.52.0 type contract + `tests/gemini.test.ts` | VERIFIED against the SDK, **not** against a live session |
| Gemini live tool calling is non-blocking | — | UNVERIFIED — claimed as `blocking` on purpose |
| Gemini native result scheduling | — | UNVERIFIED — claimed as `false` on purpose |
| Czech recognition of the robot prompt | — | UNVERIFIED — needs this procedure |

Capabilities are deliberately under-claimed where unverified. Over-claiming
`toolCalling: "async"` would make the runtime skip its degraded path and drop a
result rather than queue it.

## Prerequisites

- `GEMINI_API_KEY` in the environment or `.env` beside the config. Never print it,
  never paste it into a trace, never commit it.
- A working microphone and speaker. Echo cancellation settings as configured.
- Local Whisper input transcription available, or `inputTranscription.enabled: false`.
- `delegation.enabled: true`, with `delegation.model` set to an available text
  Gemini model with function calling. It must not equal `realtime.model` —
  they are two different roles.
- A `usage.priceCatalog` with an entry for both the voice and the delegation
  model, or an explicit `usage.unknownCostPolicy` you accept. The default is
  `block`, which will refuse an unpriced call rather than spend blind.
- Seeded memories to disambiguate. Three active records for the active subject,
  all matching "robot", with distinguishable content.

## Procedure

1. Start the assistant with delegation enabled and traces captured to a file.
2. Say, in Czech: **„Pamatuješ si, jak jsme řešili toho nového robota?“**
3. Observe the acknowledgement. It must arrive within roughly a second, and it
   must not contain an answer. The exact wording is the model's own — no sentence
   is hardcoded in the runtime.
4. **Keep talking** while the delegation runs. Say anything. This is the whole
   point of the feature: confirm the session still hears you and still responds.
5. Wait for the result. Confirm the assistant then names three candidates and
   asks which one you meant.

## What to record

Copy these from the trace, not from memory:

- lifecycle order: `delegation.created` → `accepted` → `started` → `progress` →
  `completed` → `delivery.queued`/`delivery.sent`;
- whether `delegation.delivery.degraded` appeared. If it did, native injection was
  unavailable at runtime regardless of what the SDK types promise — record that;
- the correlation IDs on every event: `sessionId`, `interactionId`, `executionId`;
- the acknowledgement latency and the total delegation latency;
- the usage summary: per-call tokens, retries, tool calls, and estimated cost with
  its price-catalog version;
- whether the transcript stream contains the delegation result. It must not. A
  result appearing as `transcript.final` with `source: "input"` is a defect, not a
  cosmetic issue;
- whether Whisper transcribed the Czech prompt correctly, verbatim, including
  where it did not.

## Failure modes worth distinguishing

- **No acknowledgement**: the voice model did not call `intelligence_delegate`.
  Check that the voice catalogue actually contains it and nothing else it might
  prefer.
- **An answer with no delegation**: the voice model invented a result. The
  acknowledgement instruction sets `doNotInventResult`; record the exact wording it
  produced instead.
- **Acknowledgement but no result**: check for `delegation.failed` and its code.
  Model failures cross the boundary as a code and a retry flag only, so the code is
  what you have.
- **Result never spoken**: check the delivery mode. `silent` is recorded as sent
  without speaking, which is correct behaviour, not a bug.
- **Result arrives as user speech**: a contract violation. Stop and report it.

## After the run

Record the outcome in the affected repository's `PROGRESS.md` as VERIFIED,
DEGRADED, or UNVERIFIED — with the date and the model names used. Do not promote
an offline pass to a hardware claim, and do not leave a degraded run recorded as a
verified one.
