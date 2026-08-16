# Assistant Runtime

[![CI](https://github.com/Brightwav3/assistant-runtime/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Brightwav3/assistant-runtime/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Assistant Mark I](https://img.shields.io/badge/Part%20of-Assistant%20Mark%20I-6f42c1)](https://github.com/Brightwav3/Assistant-mark-I)

Headless composition runtime for the Gemini Live-based assistant.

## Native-only runtime boundary

The production runtime has one speech path: cleaned microphone PCM enters
`realtime-core`, `GeminiLiveProvider` owns speech understanding and response
audio, and this repository coordinates lifecycle, memory, tools, state, and
echo cancellation around that session.

The former local `Scribe Core → Intelligence Core → Voice Core` composition is
retired and is deliberately not a runtime dependency. There is no active
`modular` mode, local Whisper input-transcription hook, or local TTS fallback in
this repository. Scribe Core and Voice Core remain independent sibling projects;
they are not installed or built by this runtime's CI.

## Delegated voice intelligence

A voice session can hand deeper work to a separately configured reasoning model,
keep talking while it runs, and speak the result when it arrives. Hardware-verified
2026-08-14 with Gemini Live 3.1 and a `gemini-3.5-flash-lite` delegation model, at
roughly two seconds end to end.

```text
voice model                     delegated text model
  intelligence_delegate           memory_search, memory_view
  (and nothing else)              (never intelligence_delegate)
        │                                   ▲
        ▼                                   │
  Delegation Broker ──────► Intelligence Core
        │                          │
        │                     Tool System ──► Memory Core
        ▼
  Delivery Scheduler ──► the same session, labelled source=delegation
        interrupt / when_idle / silent
```

Why it is shaped this way:

- **The acknowledgement must be true when it is spoken.** The broker returns an
  execution identity before any model runs, so the voice model has something real
  to acknowledge instead of stalling or inventing an answer.
- **A background result is not user speech.** It arrives as a context event with
  `source: "delegation"`, never as a transcript, and the degraded path announces
  itself so a trace can always tell the two apart.
- **Neither model can widen its own reach.** The voice model gets one tool; the
  delegated model gets the downstream catalogue but not the delegation tool, which
  would let it recurse. Bounds are enforced inside Memory Core, not trusted to a
  declaration a model can read.
- **Roles are independent settings.** `delegation.model` is never derived from
  `realtime.model`, so a voice upgrade cannot silently change what reasons.

Enable it with `delegation.enabled` (off by default; it requires memory). The manual
evidence procedure, including what remains unverified, is in
[docs/delegated-voice-smoke-test.md](./docs/delegated-voice-smoke-test.md).

## Session handoff

A realtime session has a context limit; a conversation should not. The runtime
holds the conversation and the session only renders it, so a session can be
replaced without ending the conversation: a replacement is opened and prefilled
with compacted context, and becomes active during a gap in the conversation.

What this repository owns: the handoff lifecycle (`prepare` → `ready` →
`commit` → `teardown`, plus `abort`), the runtime-measured context estimate and
its threshold, compaction submitted through the Delegation Broker, the idle gate,
published status, and bounded metrics. Realtime Core holds the sessions and is
told nothing about handoff.

What it explicitly does not do: warm a provider instance, transfer key-value
cache, or cut over mid-generation. Those need access to the model instance, which
an API client does not have.

Configure it under `handoff` (`enabled` is off by default). When enabled
together with delegation, the assembly is attached to the live realtime path.
The 2026-08-16 Windows hardware qualification reached prepare, compaction,
prefill, commit, post-handoff recall, and delegated shutdown; the operator
confirmed that the cutover was inaudible and that AEC remained effective. The
session-handoff scenario is therefore **VERIFIED** on that hardware. The
voice-to-voice model's heard understanding is authoritative for Czech input;
provider transcript text may be garbage when its language detection is wrong.
See
[PROGRESS.md](./PROGRESS.md) and the
[manual smoke test](./docs/session-handoff-smoke-test.md).

## Commands

```powershell
npm run verify
npm run build
node dist/cli/main.js health
node dist/cli/main.js capabilities
node dist/cli/main.js start
node dist/cli/main.js start --json
```

## One-click local launcher

Copy `config.example.json` to ignored `config.json`, copy `.env.example` to `.env`, put `GEMINI_API_KEY=<key>` in `.env`, then run `start-jarvis.ps1`. Stop it with `Ctrl+C`. `.env` is ignored by Git and the loader never prints its contents. Automatic conversation summaries are stored in `C:\Users\Sajmon\Jarvis\.runtime\memory.sqlite`; use `reset-memory.ps1` for the explicit destructive memory reset.

`health`, `capabilities`, `status`, and `memory` produce JSON. `start` uses a
compact human-readable console by default; add `--json` for the full event
stream. `start` runs until `SIGINT` or `SIGTERM`.

## Heard evidence and memory extraction

For microphone debugging, set `debug.heard` to `true` in the ignored
`config.json`. The realtime model then calls `record_heard` once per user turn.
Each runtime start reserves a separate file under `.runtime` named
`heard-YYYYMMDD-HHmm.jsonl`; a same-minute collision receives a numeric suffix.
Records contain `heard_id`, `session_id`, the model's `verbatim` rendering,
its `meaning`, detected `language`, and `uncertain_parts` so a run can be
audited without storing raw audio.

When this mode is enabled, the memory pipeline uses the `meaning` from
`record_heard` as the user turn and ignores the provider's `transcript.final`
input for episode and semantic-memory extraction. `verbatim` remains diagnostic
evidence, not the canonical memory text. At session close, the configured
delegation model may propose memory candidates; Memory Core still decides
whether each candidate is stored, confirmed, kept as episode-only context, or
discarded. The feature is opt-in and model-derived: it improves the wrong-script
problem, but it is not a raw speech-recognition transcript.

## Public API

`AssistantRuntime` owns lifecycle, deterministic component order, interaction orchestration, cancellation, inactivity cleanup, aggregated health/capabilities, and State Core publication. `createAssistantRuntime()` composes configured activation, microphone, Gemini Live realtime, SQLite memory, State Core, and safe read-only Host Tools components. The default realtime declarations are `get_time`, `calculate`, `uptime`, and `system_status`; callers can pass a `RealtimeToolExecutor` through `AssistantCompositionOptions` to replace that catalogue. Side-effecting tools such as `open_app` are not created by default.

## Echo cancellation

On open speakers the assistant hears itself, and the provider's voice activity detection cannot tell that voice from the user's — measured on 2026-08-14, it interrupted itself before a conversation could start. `echoCancellation` in `config.json` puts [AEC System](https://github.com/Brightwav3/aec-system) between the microphone and the provider: what the assistant plays becomes a reference, and what the provider receives is capture with that reference removed.

`processor` is `cancel_or_suppress` (the filter's output while it reports measurable cancellation, the gate's when it does not), `adaptive` (full duplex always), or `gate` (certain, but no voice barge-in).

Suppression is not necessarily silence. `bargeInMargin` lifts it for sound too loud to be echo — the echo level is measured continuously from the capture being suppressed rather than configured, because it is a property of the room and the microphone gain, not of this repository. Measured on a Bluetooth speaker, this is what makes barge-in work at all: the filter reaches 4.4 dB there, so cancellation is not what restores full duplex.

`recordDir` writes the played, captured, and cleaned streams for offline analysis; it records the microphone, so it is off by default and worth switching off again after tuning.

Activation keeps receiving raw capture — a double clap is not echo and must still be heard while the assistant is speaking. The procedure for testing this on hardware is [`docs/echo-cancellation-smoke-test.md`](./docs/echo-cancellation-smoke-test.md); no run has happened yet.

## Boundaries

This repository does not implement activation detection, microphone capture, STT, TTS, model reasoning, state storage, provider protocols, or device networking. It does not implement echo cancellation either; it composes AEC System's public contract. Gemini Live owns speech understanding and response audio; this runtime stores conversation episodes through Memory Core and routes tool calls through Tool System. When delegated extraction is enabled, semantic-memory candidates are proposed by the separately configured reasoning model and accepted or rejected by the memory pipeline. Raw audio and full audio archives are not stored. The realtime adapter frameizes native input into 20 ms PCM frames and discovers/executes the active Tool System catalogue without duplicating its policy boundary. The CLI can still add durable facts, preferences, and instructions explicitly.

## Diagnostics

```powershell
node dist/cli/main.js health --json
node dist/cli/main.js capabilities --json
node dist/cli/main.js status --json
node dist/cli/main.js memory list --json
node dist/cli/main.js memory add --kind=preference --text="The user prefers concise answers." --json
node dist/cli/main.js memory search --query=concise --json
node dist/cli/main.js memory forget --id=<memory-id> --json
```

## Current integration note

The repository provides a production composition root and tested adapter contracts. No private-source import is used here. The Mark I native path was verified on real Windows hardware with Gemini Live, barge-in, memory, and the default realtime tools. Repeating that run still requires a Windows microphone, speaker, `ffplay.exe`, and `GEMINI_API_KEY` loaded from the local `.env` or explicitly supplied process environment.
