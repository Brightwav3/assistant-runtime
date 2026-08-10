# Assistant Runtime v0.1 — Workplan

## Goal and principle

Build the headless runtime that composes independent assistant cores. Cores own capabilities; this repository owns composition.

## Scope

Lifecycle; deterministic start/stop; activation-to-interaction orchestration; native realtime and modular adapter boundaries; interaction identity, cancellation and inactivity cleanup; health/capability aggregation; JSON CLI; optional State Core publication.

## Non-goals

No STT, TTS, provider SDK, model reasoning, memory/state storage, device protocol, activation detection, GUI, secret storage, or copied core implementation.

## Neighbor relationship

Activation, Speech, Intelligence, Memory, State, Device Network and Core Runtime remain separate repositories. This repository requires their public package boundaries for real adapters and otherwise uses its local contracts/fakes.

## Contracts and security

The public contract is `AssistantRuntime` plus the adapter interfaces in `src/contracts.ts`. Errors have stable codes. Configuration carries no secrets; `.env*` is ignored. No raw audio, transcripts, prompts, or memory payloads are logged.

## Verification

`npm run verify` typechecks, runs offline unit/integration-style tests, and builds. Real native and modular smoke tests are pending published sibling package entry points and local credentials/audio devices.

## Definition of done and stop condition

The repository stops at the verified headless composition foundation: lifecycle, orchestration, failure cleanup, JSON diagnostics, tests, docs, hygiene, and a remote repository. Real core/hardware demonstrations remain explicitly blocked on sibling public package publication; no private import workaround is allowed.
