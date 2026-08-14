import assert from "node:assert/strict";
import test from "node:test";

import { PriceCatalog, type ModelPriceEntry, type UsageRecord } from "intelligence-core";
import { RuntimeUsageStore } from "../src/observability/usage-store.js";
import { loadRuntimeSettings } from "../src/config.js";

const chatPrice: ModelPriceEntry = {
  provider_id: "gemini", model_pattern: "gemini-2.5-flash", currency: "USD",
  input_per_million: 1, output_per_million: 2,
  effective_from: "2000-01-01T00:00:00.000Z", catalog_version: "test-1",
};

const voicePrice: ModelPriceEntry = {
  provider_id: "gemini", model_pattern: "gemini-*-live-*", currency: "USD",
  input_audio_per_minute: 0.06, output_audio_per_minute: 0.24,
  effective_from: "2000-01-01T00:00:00.000Z", catalog_version: "test-1",
};

const window = { from: "2026-08-14T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" };

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  schema: "usage.record.v1",
  record_id: "rec-1",
  occurred_at: "2026-08-14T12:00:00.000Z",
  call_id: "call-1",
  attempt: 1,
  provider_id: "gemini",
  model: "gemini-2.5-flash",
  operation: "chat",
  role: "delegation",
  outcome: "completed",
  dimensions: { input_tokens: 1_000_000 },
  model_calls: 1,
  tool_calls: 0,
  retry_count: 0,
  latency_ms: 100,
  usage_source: "provider",
  redacted: true,
  ...overrides,
});

const store = (entries: ModelPriceEntry[] = [chatPrice, voicePrice]) =>
  new RuntimeUsageStore({ catalog: new PriceCatalog({ entries }), append: async () => undefined });

test("voice and delegation usage share one record schema and summarize side by side", () => {
  const usage = store();
  usage.record(record({ record_id: "a", role: "delegation", operation: "chat" }));
  usage.record(record({
    record_id: "b", role: "voice", operation: "realtime", model: "gemini-3.1-flash-live-preview",
    dimensions: { input_audio_seconds: 60, output_audio_seconds: 30 },
  }));

  const summaries = usage.summarize({ ...window, groupBy: ["role"] });
  assert.equal(summaries.length, 2);
  const voice = summaries.find((entry) => entry.group.role === "voice");
  assert.equal(voice?.dimensions.input_audio_seconds, 60);
  assert.equal(voice?.cost.total_cost, 0.18);
  const delegation = summaries.find((entry) => entry.group.role === "delegation");
  assert.equal(delegation?.dimensions.input_tokens, 1_000_000);
  assert.equal(delegation?.cost.total_cost, 1);
});

test("a delegation exposes per-call tokens, retries, tool calls, latency, and cost", () => {
  const usage = store();
  usage.record(record({ record_id: "a", call_id: "call-1", attempt: 1, outcome: "failed", retry_count: 0, latency_ms: 50, dimensions: {}, usage_source: "unknown" }));
  usage.record(record({ record_id: "b", call_id: "call-1", attempt: 2, outcome: "completed", retry_count: 1, latency_ms: 150, tool_calls: 3 }));

  const [summary] = usage.summarize({ ...window, groupBy: ["role"] });
  assert.equal(summary?.calls, 2, "both physical attempts");
  assert.equal(summary?.logical_calls, 1, "one logical call");
  assert.equal(summary?.retries, 1);
  assert.equal(summary?.tool_calls, 3);
  assert.equal(summary?.unknown_usage_calls, 1);
  assert.equal(summary?.dimensions.input_tokens, 1_000_000, "the failed attempt reported no usage, so it adds nothing");
  assert.equal(summary?.latency_ms.max, 150);
  assert.equal(summary?.cost.total_cost, 1);
  assert.equal(summary?.cost.unknown_cost_calls, 1);
});

test("forecasts expose average, p50, and p95 scenarios", () => {
  const usage = store();
  for (const tokens of [1_000_000, 1_000_000, 1_000_000, 5_000_000]) {
    usage.record(record({ record_id: `r-${tokens}-${Math.random()}`, dimensions: { input_tokens: tokens } }));
  }
  const average = usage.forecast({ ...window, projectedCalls: 100, scenario: "average" });
  const p50 = usage.forecast({ ...window, projectedCalls: 100, scenario: "p50" });
  const p95 = usage.forecast({ ...window, projectedCalls: 100, scenario: "p95" });

  assert.equal(p50.total_cost, 100);
  assert.equal(p95.total_cost, 500);
  assert.equal(average.total_cost, 200);
  assert.equal(average.currency, "USD");
  assert.equal(average.status, "estimated");
});

test("an unpriced history forecasts as unavailable and reports its unknown exposure", () => {
  const usage = store([]);
  usage.record(record());
  usage.record(record({ record_id: "b" }));
  const forecast = usage.forecast({ ...window, projectedCalls: 1_000 });
  assert.equal(forecast.status, "unavailable");
  assert.equal(forecast.total_cost, undefined);
  assert.equal(forecast.unknown_cost_calls, 2);
});

test("the runtime defaults fail closed on unknown cost and keep delegation opt-in", async () => {
  const settings = await loadRuntimeSettings("C:\\this\\path\\does\\not\\exist\\config.json");
  assert.equal(settings.usage.unknownCostPolicy, "block");
  assert.equal(settings.usage.enabled, true);
  assert.equal(settings.delegation.enabled, false);
  assert.equal(settings.delegation.defaultDelivery, "when_idle");
  assert.equal(settings.delegation.lateResultPolicy, "queue");
  // The delegation model is its own setting and is never derived from the voice model.
  assert.notEqual(settings.delegation.model, settings.realtime.model);
});
