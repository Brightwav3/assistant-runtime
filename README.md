# Assistant Runtime

Headless, provider-independent composition runtime for the independent assistant cores.

## Commands

```powershell
npm run verify
npm run build
node dist/cli/main.js health
node dist/cli/main.js capabilities
node dist/cli/main.js start
```

## One-click local launcher

Copy `config.example.json` to ignored `config.json`, copy `.env.example` to `.env`, put `GEMINI_API_KEY=<key>` in `.env`, then run `start-jarvis.ps1`. Stop it with `Ctrl+C`. `.env` is ignored by Git and the loader never prints its contents. Automatic conversation summaries are stored in `C:\Users\Sajmon\Jarvis\.runtime\memory.sqlite`; use `reset-memory.ps1` for the explicit destructive memory reset.

All diagnostic commands produce one JSON object. `start` runs until `SIGINT` or `SIGTERM`.

## Public API

`AssistantRuntime` owns lifecycle, deterministic component order, interaction orchestration, cancellation, inactivity cleanup, aggregated health/capabilities, and State Core publication. `createAssistantRuntime()` composes configured activation, microphone, native realtime, SQLite memory, and State Core components. Realtime tools are optional: pass a `RealtimeToolExecutor` through `AssistantCompositionOptions` to expose an existing Tool System runtime; no host tool is created by default.

## Boundaries

This repository does not implement activation detection, microphone capture, STT, TTS, model reasoning, state storage, provider protocols, or device networking. It composes their public contracts and automatically stores compact input/output conversation summaries through Memory Core; raw audio and full audio archives are not stored. The realtime adapter frameizes native input into 20 ms PCM frames and can execute explicitly injected tools through Tool System without duplicating its policy boundary. The CLI can still add durable facts, preferences, and instructions explicitly.

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

The repository provides a production composition root and tested adapter contracts. No private-source import is used here. Real local/hardware smoke tests still require a Windows microphone, speaker, `ffplay.exe`, and `GEMINI_API_KEY` loaded from the local `.env` or explicitly supplied process environment.
