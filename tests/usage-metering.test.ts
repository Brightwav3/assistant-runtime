import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PriceCatalog, type ModelPriceEntry, type UsageRecord } from "intelligence-core";
import { RuntimeUsageStore } from "../src/observability/usage-store.js";

const price: ModelPriceEntry = {
  provider_id: "gemini", model_pattern: "gemini-2.5-flash", currency: "USD",
  input_per_million: 1, output_per_million: 2,
  effective_from: "2000-01-01T00:00:00.000Z", catalog_version: "test-1",
};

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  schema: "usage.record.v1",
  record_id: "rec-1",
  occurred_at: "2026-08-14T12:00:00.000Z",
  session_id: "session-1",
  interaction_id: "interaction-1",
  execution_id: "del-1",
  call_id: "call-1",
  attempt: 1,
  provider_id: "gemini",
  model: "gemini-2.5-flash",
  operation: "chat",
  role: "delegation",
  outcome: "completed",
  dimensions: { input_tokens: 1_000_000, output_tokens: 500_000 },
  model_calls: 1,
  tool_calls: 2,
  retry_count: 0,
  latency_ms: 120,
  usage_source: "provider",
  redacted: true,
  ...overrides,
});

const store = (append?: (line: string) => Promise<void>) =>
  new RuntimeUsageStore({ catalog: new PriceCatalog({ entries: [price] }), ...(append ? { append } : {}) });

test("records are appended as one JSON line each and carry only metrics and identifiers", async () => {
  const written: string[] = [];
  const usage = store(async (line) => { written.push(line); });
  usage.record(record());
  await usage.flush();

  assert.equal(written.length, 1);
  const parsed = JSON.parse(written[0]!.trim()) as UsageRecord;
  assert.equal(parsed.schema, "usage.record.v1");
  assert.equal(parsed.execution_id, "del-1");
  assert.equal(parsed.session_id, "session-1");
  assert.equal(parsed.redacted, true);
  assert.equal(parsed.dimensions.input_tokens, 1_000_000);
});

test("a record carrying content is refused before anything is written", async () => {
  const written: string[] = [];
  const usage = store(async (line) => { written.push(line); });
  assert.throws(() => usage.record({ ...record(), prompt: "tajne" } as unknown as UsageRecord), /redact/i);
  await usage.flush();
  assert.equal(written.length, 0);
});

test("summaries and costs are computed from the persisted records", async () => {
  const usage = store(async () => undefined);
  usage.record(record({ record_id: "a" }));
  usage.record(record({ record_id: "b", outcome: "failed" }));
  const [summary] = usage.summarize({ from: "2026-08-14T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z", groupBy: ["provider_id", "model", "role"] });
  assert.equal(summary?.calls, 2);
  assert.equal(summary?.successful_calls, 1);
  assert.equal(summary?.failed_calls, 1);
  assert.equal(summary?.tool_calls, 4);
  assert.equal(summary?.cost.total_cost, 4);
  assert.equal(summary?.cost.price_catalog_version, "test-1");
});

test("records survive a restart so a forecast is not reset by one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-usage-"));
  try {
    const path = join(dir, "nested", "usage.jsonl");
    const first = new RuntimeUsageStore({ path, catalog: new PriceCatalog({ entries: [price] }) });
    first.record(record({ record_id: "a" }));
    first.record(record({ record_id: "b" }));
    await first.flush();

    assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);

    const restarted = new RuntimeUsageStore({ path, catalog: new PriceCatalog({ entries: [price] }) });
    assert.equal(await restarted.load(), 2);
    assert.equal(restarted.records().length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a malformed persisted line is skipped rather than failing startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-usage-"));
  try {
    const path = join(dir, "usage.jsonl");
    const seeded = new RuntimeUsageStore({ path, catalog: new PriceCatalog({ entries: [price] }) });
    seeded.record(record());
    await seeded.flush();
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "{ truncated\n", "utf8");

    const restarted = new RuntimeUsageStore({ path, catalog: new PriceCatalog({ entries: [price] }) });
    assert.equal(await restarted.load(), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a missing store file is an empty history, not a startup failure", async () => {
  const usage = new RuntimeUsageStore({ path: join(tmpdir(), "assistant-usage-does-not-exist", "usage.jsonl"), catalog: new PriceCatalog({ entries: [price] }) });
  assert.equal(await usage.load(), 0);
});

test("concurrent flushes serialize instead of interleaving partial lines", async () => {
  const written: string[] = [];
  const usage = store(async (line) => { await new Promise((resolve) => setTimeout(resolve, 1)); written.push(line); });
  usage.record(record({ record_id: "a" }));
  const first = usage.flush();
  usage.record(record({ record_id: "b" }));
  await Promise.all([first, usage.flush()]);
  assert.equal(written.length, 2);
  for (const batch of written) {
    for (const line of batch.trim().split("\n")) JSON.parse(line);
  }
});
