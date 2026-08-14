# Assistant Runtime

[![CI](https://github.com/Brightwav3/assistant-runtime/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Brightwav3/assistant-runtime/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Assistant Mark I](https://img.shields.io/badge/Part%20of-Assistant%20Mark%20I-6f42c1)](https://github.com/Brightwav3/Assistant-mark-I)

Headless, provider-independent composition runtime for the independent assistant cores.

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

## Public API

`AssistantRuntime` owns lifecycle, deterministic component order, interaction orchestration, cancellation, inactivity cleanup, aggregated health/capabilities, and State Core publication. `createAssistantRuntime()` composes configured activation, microphone, native realtime, SQLite memory, State Core, and safe read-only Host Tools components. The default realtime declarations are `get_time`, `calculate`, `uptime`, and `system_status`; callers can pass a `RealtimeToolExecutor` through `AssistantCompositionOptions` to replace that catalogue. Side-effecting tools such as `open_app` are not created by default.

## Echo cancellation

On open speakers the assistant hears itself, and the provider's voice activity detection cannot tell that voice from the user's — measured on 2026-08-14, it interrupted itself before a conversation could start. `echoCancellation` in `config.json` puts [AEC System](https://github.com/Brightwav3/aec-system) between the microphone and the provider: what the assistant plays becomes a reference, and what the provider receives is capture with that reference removed.

`processor` is `cancel_or_suppress` (the filter's output while it reports measurable cancellation, the gate's when it does not), `adaptive` (full duplex always), or `gate` (certain, but no voice barge-in).

Suppression is not necessarily silence. `bargeInMargin` lifts it for sound too loud to be echo — the echo level is measured continuously from the capture being suppressed rather than configured, because it is a property of the room and the microphone gain, not of this repository. Measured on a Bluetooth speaker, this is what makes barge-in work at all: the filter reaches 4.4 dB there, so cancellation is not what restores full duplex.

`recordDir` writes the played, captured, and cleaned streams for offline analysis; it records the microphone, so it is off by default and worth switching off again after tuning.

Activation keeps receiving raw capture — a double clap is not echo and must still be heard while the assistant is speaking. The procedure for testing this on hardware is [`docs/echo-cancellation-smoke-test.md`](./docs/echo-cancellation-smoke-test.md); no run has happened yet.

## Boundaries

This repository does not implement activation detection, microphone capture, STT, TTS, model reasoning, state storage, provider protocols, or device networking. It does not implement echo cancellation either; it composes AEC System's public contract. It composes their public contracts and automatically stores compact input/output conversation summaries through Memory Core; raw audio and full audio archives are not stored. The realtime adapter frameizes native input into 20 ms PCM frames and discovers/executes the active Tool System catalogue without duplicating its policy boundary. The CLI can still add durable facts, preferences, and instructions explicitly.

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
