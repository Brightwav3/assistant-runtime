/**
 * Two defects the first hardware run with host tools exposed.
 *
 * Both were found in `trace-20260815-172539.jsonl`, and neither would have been caught by
 * the offline suite as it stood: one is a contract the delegated model can only fail at
 * runtime, the other is a log line that described working behaviour as a failure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseDelegationResult } from "../src/delegation/broker.js";
import { DelegationDeliveryScheduler } from "../src/delegation/delivery.js";
import type { DelegationEvent } from "../src/contracts.js";

const completed = (sessionId?: string): Extract<DelegationEvent, { type: "delegation.completed" }> => ({
  type: "delegation.completed",
  requestId: "req-1",
  executionId: "exec-1",
  ...(sessionId ? { sessionId } : {}),
  status: "completed",
  result: { schema: "delegation.result.v1", summary: "hotovo", data: {}, references: [] },
  occurredAt: "2026-08-15T00:00:00.000Z",
} as never);

test("a host-tool answer with no evidence to cite is a valid result", () => {
  // `system_status` ran in 203 ms and the delegation was still reported as failed: the model
  // had no memory and no conversation turn to reference, so it invented one and the broker
  // refused it. An empty references array is the honest answer and must be accepted.
  const result = parseDelegationResult({
    schema: "delegation.result.v1",
    summary: "Počítač běží normálně.",
    data: { operation: "host_tool", tool: "system_status", result: "cpu 12%, memory 40%" },
    references: [],
  });

  assert.ok(result, "a host-tool answer citing nothing must still be a result");
  assert.deepEqual(result!.references, []);
  assert.equal((result!.data as { tool: string }).tool, "system_status");
});

test("an invented reference is still refused", () => {
  // The permissive case above must not become a hole. A reference that names neither a
  // memory nor a conversation turn is exactly what the model produced when it improvised.
  const invented = parseDelegationResult({
    schema: "delegation.result.v1",
    summary: "Počítač běží normálně.",
    data: { operation: "host_tool" },
    references: [{ provenance: { sourceType: "host_tool" } }],
  });
  assert.equal(invented, undefined, "evidence must be a memory or a conversation turn, or absent");
});

test("a silent result without a session is delivered silently, not reported as lost", async () => {
  // Compaction deliberately carries no session id so it can outlive the session it replaces.
  // Reporting that as NO_SESSION described a working handoff as a dropped answer, at exactly
  // the moment the user was waiting for one.
  const events: DelegationEvent[] = [];
  const scheduler = new DelegationDeliveryScheduler({ emit: (event) => events.push(event) });

  await scheduler.deliver(completed(), { mode: "silent", lateResult: "drop" });

  const types = events.map((event) => event.type);
  assert.deepEqual(types, ["delegation.delivery.sent"], "silent is an outcome, not a loss");
  assert.equal(types.includes("delegation.delivery.dropped"), false);
});

test("a spoken result with no session is still reported as lost", async () => {
  // The NO_SESSION path is narrowed, not removed: a result that was meant to be spoken and
  // has nowhere to go is a real loss and must stay visible.
  const events: DelegationEvent[] = [];
  const scheduler = new DelegationDeliveryScheduler({ emit: (event) => events.push(event) });

  await scheduler.deliver(completed(), { mode: "when_idle", lateResult: "drop" });

  const dropped = events.find((event) => event.type === "delegation.delivery.dropped");
  assert.ok(dropped, "an answer nobody can hear is a loss");
  assert.equal((dropped as { reason?: string }).reason, "NO_SESSION");
});
