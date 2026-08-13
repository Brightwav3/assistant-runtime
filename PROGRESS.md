# Progress

## Current state

**IN PROGRESS — the native path is verified on real hardware; modular live-path verification remains.** The repository contains a headless lifecycle/runtime, configuration-driven composition root, JSON CLI, public-core adapters, native realtime wiring, SQLite memory, State Core publication, offline tests, documentation, and repository hygiene configuration.

Verified on 2026-08-11: `npm run verify` passed (TypeScript typecheck, 15 offline integration tests, and build). JSON `health`, `capabilities`, `status`, and memory commands returned valid structured output.

Verified on real hardware on 2026-08-12, every step of [the hardware smoke test](./docs/hardware-smoke-test.md): double-clap activation, a Gemini Live session, an audible spoken answer, barge-in stopping playback immediately, a conversation summary written to memory, the inactivity timeout ending the interaction on its own, memory recalled after a restart, and the memory CLI listing it. Component lifecycle, failure isolation, and health aggregation are now owned by Core Runtime's registry rather than a second local implementation.

Verified offline on 2026-08-13: the native realtime boundary exposes timestamped
tool contracts, Gemini function-call translation, 20 ms input frameization, a
newest-500-ms pending bound, Tool System execution/cancellation, and aggregate
input/tool/playback traces. `npm run verify` passed with 33 tests in this
repository and `npm run verify` passed in Realtime Core with 16 tests.

## Integration audit

Activation, Intelligence, Memory, State, and Speech public package entry points are consumed without private-source imports. The production composition root constructs the configured Activation, Realtime, Memory, and State components together.

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
- Realtime tool calls use an explicitly injected `ToolSystemRealtimeToolExecutor`; the default composition advertises no host tools.
- Local Gemini credentials are loaded from ignored `.env` files without logging or committing their values; explicit process variables still take precedence.
- `remove-jarvis-wiring.ps1` preserves memory; `reset-memory.ps1` is the explicit memory deletion command.

## Remaining work

- Run the real native smoke test with a local microphone, speaker, `ffplay.exe`, and `GEMINI_API_KEY`.
- Run the explicit Calculator tool smoke test in [the separate procedure](./docs/realtime-tools-smoke-test.md).
- Implement and verify the config-selectable Scribe → Intelligence → Voice live path.

## Known limitations

- Real microphones can still occasionally lose speech detection.
- After `realtime.session.closed`, a new activation is required; automatic session reopening is not implemented yet.
- Conversation memory stores compact summaries, but does not yet infer intelligent preferences or facts automatically.
- The modular Scribe → Intelligence → Voice path has offline boundary coverage but is not fully hardware-verified.
- The explicit Calculator realtime tool probe is documented but not claimed as hardware-verified in this pass.

## Explicit operational nuance

The remaining native and modular end-to-end checks require local microphone, speaker, `ffplay.exe`, and `GEMINI_API_KEY`. They are not represented as passing automated tests because those external resources are not deterministic in the offline suite.
