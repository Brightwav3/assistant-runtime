# ADR 0001: Cores do not import each other; Assistant Runtime is the only place that knows two vocabularies

- **Status:** Accepted
- **Date:** 2026-08-15
- **Decision owners:** M.A.R.K. II architecture
- **Retroactive:** records a decision already implemented in `src/tool-bridge.ts`
  and `src/adapters.ts`

## Context

Assistant Runtime composes seven independent repositories: Activation Core,
Realtime Core, Intelligence Core, Memory Core, State Core, Tool System, and Host
Tools. Each defines its own vocabulary for overlapping concepts — a tool
declaration, a session, a request identity, an event.

The cheapest way to make two of them work together is for one to import the
other's types. It is one line, it type-checks, and it is how a set of replaceable
components quietly becomes one system that must be replaced whole. Once Memory
Core imports Intelligence Core, neither can be swapped, tested, or versioned
alone, and the boundary that justified splitting them is gone.

The pressure is strongest exactly where the value is highest: a model driving real
capabilities requires Intelligence Core's action loop to reach Tool System's
registry.

## Decision

**No core imports another core.** Where two vocabularies must meet, exactly one
file in Assistant Runtime knows both and translates between them.

For tools that file is `src/tool-bridge.ts`. It maps Tool System's
`ToolDeclaration` and `ExecutionOutcome` onto Intelligence Core's `ToolClient`,
`ToolDescriptor`, and `ToolResult`, and onto Realtime Core's
`RealtimeToolDeclaration`.

**The translation is deliberately thin.** Every guarantee — validation, policy,
guards, brokered execution — stays inside Tool System. Nothing in the bridge
decides whether an execution may happen; it only carries the question across.

The same shape applies elsewhere: adapters in `src/adapters.ts` present
Activation Core and Realtime Core to the runtime, and Memory Core's context
adapter implements only the external `MemoryContextProvider` shape without
importing Intelligence Core.

## Rejected alternatives

### Let Intelligence Core import Tool System directly

Rejected. It is the smallest possible change and it permanently couples the model
runtime to one tool implementation. Neither could then be tested or replaced
alone, which was the entire reason for two repositories.

### Extract a shared contracts package both cores depend on

Rejected. A shared package becomes a third thing that every core must agree on
before any of them can change, so the coupling is preserved and gains a
coordination cost. It also grows toward the union of everyone's needs.

### Let the bridge add convenience behaviour — retries, defaults, argument fixing

Rejected. Every guarantee added in the bridge is a guarantee that exists for
callers who route through it and not for callers who do not. Keeping the bridge
thin means Tool System's behaviour is Tool System's behaviour everywhere.

## Consequences

### Positive

- Any core can be swapped, versioned, or tested alone.
- The rule is checkable by reading import lists, not by tracing calls.
- One file to read when two vocabularies disagree.

### Costs

- Every cross-core concept is expressed twice and mapped once.
- The bridge grows as more cores meet, and it must stay thin under that pressure.

## Enforced in

- `src/tool-bridge.ts`
- `src/adapters.ts`
- `src/composition.ts`

## Explicit non-decisions

This ADR does not forbid a core depending on a genuinely external library, does not
govern how any core structures its own internals, and does not decide which core
owns a concept when two both claim it.
