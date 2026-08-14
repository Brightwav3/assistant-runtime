import assert from "node:assert/strict";
import test from "node:test";
import { createHumanTrace } from "../src/console-log.js";

test("the operator can see the whole delegation, not just its beginning and end", () => {
  const lines: string[] = [];
  const trace = createHumanTrace((line) => lines.push(line));

  trace({ type: "realtime.tool.requested", tool: "intelligence_delegate" });
  trace({ type: "delegation.created", executionId: "del-1" });
  trace({ type: "delegation.accepted", executionId: "del-1" });
  trace({ type: "delegation.started", executionId: "del-1" });
  trace({ type: "delegation.tool", tool: "memory_search", outcome: "result", durationMs: 12 });
  trace({ type: "delegation.tool", tool: "memory_view", outcome: "result", durationMs: 4 });
  trace({ type: "delegation.progress", modelCalls: 3, toolCalls: 2 });
  trace({ type: "delegation.completed", executionId: "del-1" });
  trace({ type: "delegation.delivery.queued", executionId: "del-1" });
  trace({ type: "delegation.delivery.sent", executionId: "del-1" });

  assert.deepEqual(lines, [
    "Používám nástroj: intelligence_delegate.",
    "Deleguji na pozadí…",
    "  └ pozadí: memory_search → ok (12 ms)",
    "  └ pozadí: memory_view → ok (4 ms)",
    "Výsledek delegace dorazil.",
    "  └ čekám, až domluvím, pak výsledek předám.",
    "  └ výsledek předán do konverzace.",
  ]);
});

test("a degraded delivery is announced rather than looking like the native path", () => {
  const lines: string[] = [];
  const trace = createHumanTrace((line) => lines.push(line));
  trace({ type: "delegation.delivery.degraded", reason: "CONTEXT_INJECTION_UNAVAILABLE" });
  trace({ type: "delegation.delivery.sent" });
  assert.deepEqual(lines, [
    "  └ POZOR: nativní vložení kontextu nedostupné, používám náhradní cestu.",
    "  └ výsledek předán do konverzace.",
  ]);
});

test("a failed or cancelled delegation reports its code instead of going quiet", () => {
  const lines: string[] = [];
  const trace = createHumanTrace((line) => lines.push(line));
  trace({ type: "delegation.failed", failure: { code: "MODEL_PROVIDER_FAILED", retryable: true } });
  trace({ type: "delegation.cancelled", failure: { code: "SESSION_CLOSED", retryable: false } });
  trace({ type: "delegation.delivery.dropped", reason: "QUEUE_OVERFLOW" });
  trace({ type: "delegation.disabled", reason: "memory is required for delegated recall" });
  assert.deepEqual(lines, [
    "Delegace selhala: MODEL_PROVIDER_FAILED.",
    "Delegace zrušena: SESSION_CLOSED.",
    "  └ výsledek zahozen: QUEUE_OVERFLOW.",
    "Delegace vypnuta: memory is required for delegated recall.",
  ]);
});

test("a failed background tool call is visible with its error code", () => {
  const lines: string[] = [];
  const trace = createHumanTrace((line) => lines.push(line));
  trace({ type: "delegation.tool", tool: "memory_search", outcome: "error", durationMs: 2, errorCode: "policy_denied" });
  assert.deepEqual(lines, ["  └ pozadí: memory_search → error (2 ms)"]);
});
