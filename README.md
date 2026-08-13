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
```

## One-click local launcher

Copy `config.example.json` to ignored `config.json` for local overrides, set `GEMINI_API_KEY`, then run `start-jarvis.ps1`. Stop it with `Ctrl+C`. Automatic conversation summaries are stored in `C:\Users\Sajmon\Jarvis\.runtime\memory.sqlite`; use `reset-memory.ps1` for the explicit destructive memory reset.

All diagnostic commands produce one JSON object. `start` runs until `SIGINT` or `SIGTERM`.

## Public API

`AssistantRuntime` owns lifecycle, deterministic component order, interaction orchestration, cancellation, inactivity cleanup, aggregated health/capabilities, and State Core publication. `createAssistantRuntime()` composes configured activation, microphone, native realtime, SQLite memory, and State Core components.

## Boundaries

This repository does not implement activation detection, microphone capture, STT, TTS, model reasoning, state storage, provider protocols, or device networking. It composes their public contracts and automatically stores compact input/output conversation summaries through Memory Core; raw audio and full audio archives are not stored. The CLI can still add durable facts, preferences, and instructions explicitly.

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

The repository provides a production composition root and tested adapter contracts. No private-source import is used here. Real local/hardware smoke tests still require a Windows microphone, speaker, `ffplay.exe`, and `GEMINI_API_KEY`.
