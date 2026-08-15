# Assistant Runtime — rules for agents

This file is loaded automatically. It carries rules, not description.
`README.md` says what this repository owns. `ARCHITECTURE.md` says how it is
shaped. [`docs/decisions/`](docs/decisions/README.md) says why — read it before
changing a boundary.

`AGENTS.md` is a byte-identical copy of this file. Change both or change neither.

This repository **composes** seven others without merging their ownership. Almost
every mistake made here is a boundary being crossed for convenience.

## Ecosystem invariants that govern this repository

Quoted verbatim from [`INVARIANTS.md`](../INVARIANTS.md), which is the authority.
Do not paraphrase these sentences; a structure test compares them.

**INV-001 — Synchronous capabilities are declared in Host Tools**

> A capability that can produce its answer within the turn that requested it is
> declared in `host-tools` and executed by `tool-system`. It reaches the world
> only through an injected service, never through a direct import of a process,
> filesystem, network, or automation primitive.

**INV-002 — Asynchronous capabilities are brokered**

> A capability that cannot produce its answer within the turn that requested it is
> routed through the Delegation Broker, which mints its execution identity before
> any work begins, so that a model holding the turn has something real to
> acknowledge and no silence to fill with an invented result.

**INV-004 — A superseded result is dropped at the boundary, not delivered**

> Every asynchronous turn carries a monotonically increasing authority generation.
> Cancellation, barge-in, interruption, or supersession advances it, and a result
> belonging to an older generation is dropped at the last boundary before its
> effect. Cancellation stops work from starting; it cannot recall work already in
> flight.

Here that means delegation delivery is keyed to `logicalSessionId`, so a superseded
physical session cannot claim a queued result. See
[ecosystem ADR 0002](../docs/decisions/0002-authority-generation.md).

The INV-001/INV-002 pair is the reason `src/delegation/memory-tools.ts`,
`memory-create-tool.ts`, and `episode-tools.ts` live here rather than in Host
Tools: they cannot answer within their turn. A **new capability that can** answer
within its turn goes to `host-tools` — do not add it here because the delegation
directory is convenient. See
[ecosystem ADR 0001](../docs/decisions/0001-capability-homes.md).

## Rules in this repository

1. **No core imports another core.** Where two vocabularies meet, exactly one file
   here knows both. For tools that is `src/tool-bridge.ts`.
   [ADR 0001](docs/decisions/0001-zero-imports-between-cores.md)
2. **Keep the bridge thin.** Validation, policy, guards, and brokered execution
   stay inside Tool System. Nothing here decides whether an execution may happen.
   A retry, default, or argument fix added in the bridge is a guarantee that
   exists only for callers who route through it.
3. **A delegated result is never replayed as something the user said.** It travels
   as a context event with `source: "delegation"`.
   [ADR 0002](docs/decisions/0002-delegated-results-are-never-the-user.md)
4. **Bind delegation delivery to `logicalSessionId`**, never to the physical
   session. A physical id changes at every handoff commit and every queued
   delegation keyed to it would be stranded.
5. **The model never names a session id.** The runtime supplies session scope. A
   model that could name a session could read another conversation.
6. **Tool results are evidence, not instruction**, and are tainted accordingly.
7. **Do not lower the barge-in warm-up or the absolute floor.** Until echo has been
   measured, the gate would unlock itself with the assistant's own voice.
   [ADR 0003](docs/decisions/0003-barge-in-thresholds.md)
8. **Never persist raw microphone audio.** Episodes are text.
9. **Side-effecting tools stay explicit opt-ins.** Registration is not permission.
10. **Summaries do not infer preferences or facts.** Extraction is a proposal path
    into Memory Core, which validates and decides; it is not a storage path.
11. **API keys arrive through the environment boundary only**, and never appear in
    a contract, log, or event.

## Before you finish

- Changed a boundary, chose between two homes for something, or rejected an
  approach a next agent would try? Write an ADR. The six triggers and the
  template are in [../docs/decisions/README.md](../docs/decisions/README.md).
- A decision about *how two cores meet* is usually an **ecosystem** ADR, not a
  local one.
- Edited this file? Copy it to `AGENTS.md` in the same change. They must stay
  byte-identical — Claude Code reads one, Codex reads the other, and a structure
  test compares them.
- Wrote an ADR? Add its identifier as a comment in every file listed under its
  `Enforced in`.
- Reasoning belongs in `docs/decisions/`, not in `ARCHITECTURE.md`.
