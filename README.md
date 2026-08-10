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

Run `start-jarvis.ps1` from Explorer or PowerShell. It creates only ignored `.runtime/` launcher state and starts the runtime; stop it with `Ctrl+C`. Run `remove-jarvis-wiring.ps1` to delete that temporary wiring. It deliberately preserves memories and every source repository.

All diagnostic commands produce one JSON object. `start` runs until `SIGINT` or `SIGTERM`.

## Public API

`AssistantRuntime` owns lifecycle, deterministic component order, interaction orchestration, cancellation, inactivity cleanup, aggregated health/capabilities, and optional State Core publication. It is configured with explicit adapters for activation, native realtime, and the modular speech path.

## Boundaries

This repository does not implement activation detection, microphone capture, STT, TTS, model reasoning, persistent memory, state storage, provider protocols, or device networking. It only composes their public contracts.

## Current integration note

The repository provides tested adapter contracts and fakes. The checked sibling packages have public TypeScript source boundaries, but several do not yet publish package `exports`/runtime entry points. No private-source import is used here. Real local/hardware smoke tests require those published package boundaries plus local audio/provider configuration; they are intentionally not represented as passing automated tests.
