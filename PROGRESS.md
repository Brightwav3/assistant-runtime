# Progress

## Current state

**MARK I COMPLETE — the native realtime path is verified on real hardware; modular live-path verification belongs to the next iteration.** The repository contains a headless lifecycle/runtime, configuration-driven composition root, JSON CLI, public-core adapters, native realtime wiring, SQLite memory, State Core publication, default safe realtime tools, human-readable and JSON logs, offline tests, documentation, and repository hygiene configuration.

Verified on 2026-08-11: `npm run verify` passed (TypeScript typecheck, 15 offline integration tests, and build). JSON `health`, `capabilities`, `status`, and memory commands returned valid structured output.

Verified on real hardware on 2026-08-12, every step of [the hardware smoke test](./docs/hardware-smoke-test.md): double-clap activation, a Gemini Live session, an audible spoken answer, barge-in stopping playback immediately, a conversation summary written to memory, the inactivity timeout ending the interaction on its own, memory recalled after a restart, and the memory CLI listing it. Component lifecycle, failure isolation, and health aggregation are now owned by Core Runtime's registry rather than a second local implementation.

Verified offline on 2026-08-13: the native realtime boundary exposes timestamped
tool contracts, Gemini function-call translation, 20 ms input frameization, a
newest-500-ms pending bound, Tool System execution/cancellation, aggregate
input/tool/playback traces, and a compact human-readable console. `npm run
verify` passed with 39 tests in this repository and `npm run verify` passed in
Realtime Core with 16 tests.

Verified on real hardware on 2026-08-13: Gemini discovered `calculate`,
`get_time`, `system_status`, and `uptime`; it executed time, system-status, and
multi-step calculation requests and spoke the results in Czech. The same run
confirmed activation, barge-in, memory, and clean session shutdown.

Verified offline on 2026-08-14: the platform boundary carries no Windows-only
defaults. `npm run verify` passed with 54 tests in this repository (typecheck,
tests, build). The new coverage proves the shared realtime stream id and the
shipped activation `sourceId` name no operating system, that
`ASSISTANT_CONFIG` → `JARVIS_CONFIG` → `config.json` precedence holds including
for blank variables, that `verifyPlayback` refuses without a player instead of
probing `ffplay.exe`, that an `unsupported` host exposes an empty player and
advertises no `ffplay` anywhere in its component capabilities, and that
composition on such a host starts and stops without throwing.

Import behaviour was measured on this host, not assumed: importing
`src/composition.js` and `activation-core` both succeed, and the `decibri`
capture binding loads eagerly through `activation-core` regardless of which
platform leaf is selected. Lazy-loading the Windows leaf was therefore
deliberately not implemented — see [ARCHITECTURE.md](./ARCHITECTURE.md).

Host status after this pass, on the project's evidence scale:

| Host | Status |
| --- | --- |
| Windows (win32) | VERIFIED — source, deterministic tests, and the prior real-hardware runs |
| macOS (darwin) | MISSING adapter / UNVERIFIED hardware |
| Linux | MISSING adapter / UNVERIFIED hardware |

No macOS or Linux hardware was exercised in this pass. TypeScript compilation is
not treated as evidence of platform support.

## Echo cancellation — working on hardware, tuned to one machine

Verified offline on 2026-08-14: `npm run verify` passed with **85 tests**
(typecheck, tests, build), up from 82. The new coverage proves that what the
provider receives is cleaned capture rather than what the microphone heard, that
untouched capture still reaches it when nothing is playing, that the playback
controller feeds the canceller exactly the samples it feeds the player, that the
reference is scheduled by playback position rather than by arrival time, that an
interrupted utterance retracts the rest of its schedule so the user is heard
immediately, and that `auto` holds the gate until the adaptive filter has
measurably converged and then returns to full duplex.

Measured in that simulation, against a 200 ms echo path: the guard held the gate
for the first 56 frames (1.1 s), returned to the adaptive filter once it
converged, and ended at **74.5 dB** of echo return loss enhancement with no
residual echo above the noise floor.

**Run on hardware on 2026-08-14, and it works — roughly.** Laptop microphone,
Bluetooth speaker, open air, Gemini Live in Czech. The assistant no longer
interrupts itself, and voice barge-in works. It is not fully characterised: the
configuration was tuned against a single 35-second recording from this machine,
and no long session, second room, or second device has been tried.

The route there is worth keeping, because the two obvious answers both failed:

1. **Gate at full strength** — stopped the self-interruption completely and
   removed barge-in with it. The provider cannot react to an interruption it is
   never sent. Measured: 72.6% of a session fully suppressed.
2. **Uniform attenuation** (`suppressionGain: 0.2`) — restored barge-in and let
   echo through with it. The provider transcribed the assistant's own sentence
   back as the user's.
3. **Level-triggered barge-in** — what shipped. The gate stays absolute, and
   capture is released only while it is too loud to be echo. Echo returns at a
   median frame peak of 105 of 32768; the user is next to the microphone and
   reaches 3000-5000, so a threshold at 0.06 separates them with margin.

Cancellation is not what fixed it. On this hardware the adaptive filter reaches
4.4 dB against 32 dB in simulation, because a Bluetooth speaker re-encodes audio
through a lossy codec and a linear filter cannot model the result. See AEC
System's PROGRESS for that measurement.

**The threshold is empirical.** It is tuned to this microphone, this speaker, and
this room, and it is the first thing to re-check on any other.

**The recordings those measurements came from were deleted on 2026-08-14**, at
the owner's request — four sessions, 37 MB of real conversation. The numbers
survive in this file and in AEC System's PROGRESS; the audio does not, so none of
them can be re-derived or re-checked against different settings. Recording is
still available through `echoCancellation.recordDir` and is off by default.

Integrating also found a gap in AEC System's contract — a host that aborts
playback must be able to retract the reference it already pushed — which was
fixed there rather than worked around here.

## Integration audit

Activation, Intelligence, Memory, State, Speech, Tool System, and Host Tools
public package entry points are consumed without private-source imports. The
production composition root constructs the configured Activation, Realtime,
Memory, State, and safe Host Tools components together.

## Completed in this pass

- `createAssistantRuntime()` composes configured Activation, microphone, Realtime, Memory, and State components.
- Settings load from ignored `config.json` with tracked `config.example.json` defaults.
- SQLite memory persists across runtime restarts; completed realtime turns are automatically stored as compact conversation summaries, and explicit JSON add/search/list/forget commands remain available for durable facts.
- Default memory path is the Jarvis-root `.runtime\\memory.sqlite`, outside the assistant-runtime repository.
- Interaction, speech, and runtime-error facts publish through State Core.
- Microphone PCM arriving during realtime connection is bounded and flushed after connect; idle PCM is not persisted.
- `mode: "modular"` composes public Scribe, Intelligence, and Voice contracts with Memory context passed through `MemoryContextAdapter`.
- Native inactivity timeout resets on speech activity; provider-closed sessions clear stale microphone routing without unhandled rejections.
- Native realtime input is split into 320-sample/20 ms frames; pre-connect audio retains only the newest 500 ms and reports dropped frames.
- Realtime tool calls use `ToolSystemRealtimeToolExecutor`; the default composition advertises the safe read-only `get_time`, `calculate`, `uptime`, and `system_status` catalogue, while side-effecting tools remain opt-in.
- Local Gemini credentials are loaded from ignored `.env` files without logging or committing their values; explicit process variables still take precedence.
- `remove-jarvis-wiring.ps1` preserves memory; `reset-memory.ps1` is the explicit memory deletion command.

## Next iteration

- Implement and verify the config-selectable Scribe → Intelligence → Voice live path.
- Keep the explicit Calculator `open_app` probe in [the separate procedure](./docs/realtime-tools-smoke-test.md); it is not part of the safe default catalogue.

## Known limitations

- Real microphones can still occasionally lose speech detection.
- After `realtime.session.closed`, a new activation is required; automatic session reopening is not implemented yet.
- Conversation memory stores compact summaries, but does not yet infer intelligent preferences or facts automatically.
- The modular Scribe → Intelligence → Voice path has offline boundary coverage but is not fully hardware-verified.
- The explicit Calculator `open_app` realtime probe remains a separate side-effect smoke test and was not part of the Mark I hardware run.

## Explicit operational nuance

The modular end-to-end check still requires a local microphone, speaker,
`ffplay.exe`, and `GEMINI_API_KEY`. It is not represented as a passing
automated test because those external resources are not deterministic in the
offline suite.

## Delegated voice intelligence (Mark II)

The voice model can now hand deeper work to a separately configured text model and
keep talking while it runs. Delegation is **opt-in** (`delegation.enabled`, default
`false`); nothing below changes the existing default runtime.

What is verified, and by what:

- Provider-neutral delegation contracts, capability negotiation, and the degraded
  fallback — `speech-system/realtime core`, offline fake providers. VERIFIED.
- Bounded delegated recall: active user scope, result and byte ceilings enforced in
  Memory Core rather than at the tool boundary, forgotten/superseded/expired records
  excluded, provenance and confidence preserved — `memory-core`. VERIFIED.
- Immediate acceptance with correlation, deadlines, and cancellation —
  `intelligence-core`. VERIFIED.
- Provider-neutral usage metering: one record per physical provider call, retries
  counted separately from logical calls, unknown usage kept unknown, versioned price
  catalog, and a fail-closed unknown-cost policy. VERIFIED.
- Broker lifecycle, delivery scheduling (`interrupt`/`when_idle`/`silent`), late-result
  policy, reconnect drain, bounded queue, and clean shutdown. VERIFIED.
- The MIT / Mars / submarine disambiguation end to end, with no API key, microphone,
  network, or generated audio. VERIFIED offline.
- Gemini active-session context injection via `sendClientContent` — **VERIFIED against a
  live session** on 2026-08-14, not only against the SDK contract: the delegated result
  was delivered with no degraded diagnostic.

Hardware run, 2026-08-14, Gemini Live voice with `gemini-3.5-flash-lite` delegation:

- the user asked in Czech, self-correcting mid-sentence, and was understood by Gemini's
  own input transcription;
- delegation was acknowledged immediately, ran `memory_search` then `memory_view`, and
  the result was queued behind the acknowledgement and delivered once the assistant
  stopped speaking — `when_idle` behaving as specified;
- the spoken answer contained the stored details (seals, cold-water battery life) and
  nothing invented;
- a follow-up question delegated again and answered from the same record;
- end-to-end delegation latency was roughly two seconds.

Observed defect from that run, not yet fixed: an unintelligible utterance transcribed
as `あの` was treated as confirmation for `end_conversation`. The host-side guarantee
held — the model may only ask, and the host decides — but the model's reading of
consent is too loose, and a garbled sound should not end a session.

What is deliberately still unverified:

- Gemini live tool calling is claimed as `blocking` and native result scheduling as
  `false`. Both are UNVERIFIED against a real session and are under-claimed on
  purpose: over-claiming async would make the runtime skip its degraded path and drop
  a result instead of queueing it.
- Czech recognition of the robot prompt, real speaker delivery, and end-to-end latency
  remain hardware-unverified. The procedure is in
  [the delegated voice smoke test](./docs/delegated-voice-smoke-test.md); a green
  fake-provider suite is not evidence for any of it.
