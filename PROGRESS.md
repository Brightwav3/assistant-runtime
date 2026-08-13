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
