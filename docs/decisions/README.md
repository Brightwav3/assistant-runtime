# Assistant Runtime decisions

Architecture Decision Records for choices contained within this repository.

A decision whose reasoning constrains code in another repository does not belong
here — it belongs in [the ecosystem decisions](../../../docs/decisions/README.md)
and, if it can be stated as a rule, in
[`INVARIANTS.md`](../../../INVARIANTS.md).

This repository composes seven others, so the boundary matters more here than
anywhere: a decision about *how two cores meet* is usually an ecosystem decision,
while a decision about *how this runtime behaves* belongs here.

`ARCHITECTURE.md` describes **how this repository is shaped**. These records
describe **why**.

## Format

```
NNNN-slug.md          four digits, no gaps, no duplicates
```

Required sections: `Context`, `Decision`, `Rejected alternatives`,
`Consequences`, `Enforced in`, `Explicit non-decisions`.

Every path under `Enforced in` carries a comment at the declaration it constrains,
naming the ADR.

## Index

- [0001 — Cores do not import each other; the bridge is the only bilingual file](0001-zero-imports-between-cores.md)
- [0002 — A delegated result enters as runtime context, never as something the user said](0002-delegated-results-are-never-the-user.md)
- [0003 — The barge-in gate measures echo before it trusts itself](0003-barge-in-thresholds.md)
- [0004 — A physical realtime session cannot end a logical interaction](0004-logical-interaction-lifecycle.md)

## See also

- [Ecosystem ADR 0001](../../../docs/decisions/0001-capability-homes.md) — why the
  delegated memory and episode tools are declared here rather than in Host Tools.
