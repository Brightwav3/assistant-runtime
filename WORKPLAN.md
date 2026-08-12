# Assistant Runtime v0.1 — Completion Workplan

## Goal

Deliver one headless, persistent assistant runtime. One command starts all configured cores, double-clap activates a real Gemini Live conversation, the user can speak naturally, answers play through the selected speaker, and approved durable facts are remembered across restarts.

## Core principle

`AssistantRuntime` owns composition and conversation lifecycle. Individual cores own their capabilities and remain independent packages. Production code uses only public package exports.

## Current evidence

Verified: Windows double-clap activation, production composition, Gemini Live microphone-to-speaker wiring, barge-in handling, persistent SQLite conversation summaries, restart-safe memory, State Core publication, timeout and shutdown behavior, public package exports, and 15 offline integration tests.

Remaining: real native microphone/speaker/Gemini smoke verification, intermittent real-microphone speech-detection hardening, automatic reopening after `realtime.session.closed`, intelligent preference/fact extraction, and full hardware verification of the modular Scribe → Intelligence → Voice path.

## Scope

- One configuration-driven composition root and CLI.
- Activation Core with Windows microphone/double-clap source.
- Native realtime path: microphone PCM -> Gemini Live -> speaker PCM.
- Persistent SQLite Memory Core with automatic compact conversation summaries and explicit, privacy-safe durable facts.
- State Core with live interaction/speech facts.
- Optional modular path: Scribe -> Intelligence -> Voice.
- Machine-readable health, capabilities, status and structured errors.
- Deterministic startup, shutdown, cancellation, timeout and stale-event handling.

## Non-goals

- GUI, cloud memory sync, automatic recording of raw audio, full audio archive, tool platform, device protocol implementation, wake-word model, or committing credentials.

## Configuration and secrets

- Load runtime settings from a tracked `config.example.json` and ignored local config/environment.
- `GEMINI_API_KEY` is read only from process environment.
- Memory database path defaults under ignored `.runtime/` and is preserved by `remove-jarvis-wiring.ps1` unless a dedicated memory-reset command is used.

## Architecture

```text
Windows microphone PCM
  -> clap detector -> activation.detected
  -> AssistantRuntime starts interaction
  -> Gemini Live receives microphone PCM
  -> Gemini audio PCM -> selected speaker

Gemini input/output transcripts
  -> automatic conversation summary policy -> SQLite Memory Core
  -> State Core publishes interaction and speech state

Next activation
  -> Memory search -> selected context -> Gemini system instruction
```

## Milestones

### 1. Production composition root

Replace the current CLI skeleton with `createAssistantRuntime(config)`. Construct every enabled core, enforce startup order, expose actual component health/capabilities, and remove fake providers from production paths.

**Proof:** `start`, `health --json`, `status --json`, and `capabilities --json` report real configured components.

### 2. Native realtime audio loop

Route each microphone PCM frame both to clap detection and the active Gemini session. Route Gemini audio chunks to playback. Add explicit events for connection, input frames, output chunks, player failures and session closure.

**Proof:** real double-clap -> Czech greeting; user speaks -> Gemini replies audibly; interruption cancels output; inactivity returns to idle.

### 3. Persistent memory

Create `MemoryRuntime` with `SqliteMemoryStore`. Automatically persist compact input/output conversation summaries; keep raw audio and full audio archives out of memory. Add JSON CLI commands to list, add, search and forget durable memories.

**Proof:** save a preference, restart runtime, ask a related question, and observe that retrieved memory changes Gemini context/answer.

### 4. State integration

Start `StateRuntime`; publish `interaction.active`, `interaction.id`, `assistant.mode`, input/output speech state and last structured error. Add State health degradation behavior.

**Proof:** status/state query reflects activation, active conversation, timeout and cleanup.

### 5. Modular speech path

Implement config-selectable Scribe -> Intelligence -> Voice path using public APIs only. Feed Memory context into Intelligence through its public context boundary. Keep native Gemini realtime and modular modes independent.

**Proof:** offline fake integration test plus local microphone/transcript -> Intelligence response -> speaker smoke test.

### 6. Reliability and safety

Add tests for no API key, microphone unavailable, Gemini connection failure, speaker/ffplay failure, duplicate clap, cancellation, timeout, stale results, partial optional-core failure and shutdown order. Redact secrets from all errors/logs.

**Proof:** failure tests pass and `health` degrades predictably without corrupting interaction state.

### 7. One-command operation and removal

`start-jarvis.ps1` validates configuration, starts the real composition root and keeps it alive. `remove-jarvis-wiring.ps1` removes only generated wiring/runtime state; a separate explicit `reset-memory.ps1` is required to delete memories.

**Proof:** clean machine-local start, clean Ctrl+C shutdown, restart retains memory, remove wiring preserves memory.

## Test strategy

- Offline unit and integration tests use fake providers only.
- Real smoke tests require local microphone, speaker, `ffplay.exe`, and `GEMINI_API_KEY`.
- Every production boundary emits machine-readable diagnostics.

## Definition of Done

Complete only when all are verified:

1. `start-jarvis.ps1` starts configured real components and remains running.
2. Double-clap -> Gemini Live greeting -> audible speaker output works.
3. User speech reaches Gemini and receives audible replies.
4. Interaction interruption, explicit stop and inactivity cleanup work.
5. Memory survives restart, is searchable, and is used as conversation context.
6. State reports current lifecycle facts.
7. Native realtime and modular paths both work through public APIs.
8. Health/status/capabilities are truthful JSON.
9. Offline test suite, typecheck and build pass.
10. Local native realtime and memory smoke tests pass with real hardware/credentials.
11. No credentials, raw audio, or unintended transcript archive are tracked.

## Stop condition

When the Definition of Done is verified, mark the runtime complete and move it to maintenance. Do not add unrelated tools, GUI, home automation or device implementations here.
