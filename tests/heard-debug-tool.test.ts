import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AllowlistPolicy, ToolRegistry, ToolRuntime } from "tool-system";
import { RECORD_HEARD_TOOL, createRunHeardPath, recordHeardDeclaration, recordHeardHandler } from "../src/heard-debug-tool.js";

test("creates a unique timestamped heard file for each run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-heard-run-"));
  const basePath = join(directory, "heard.jsonl");
  const now = new Date("2026-08-14T19:17:23.000Z");

  const first = await createRunHeardPath(basePath, now);
  const second = await createRunHeardPath(basePath, now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  assert.match(first, new RegExp(`heard-${stamp}\\.jsonl$`));
  assert.match(second, new RegExp(`heard-${stamp}-02\\.jsonl$`));
});

test("record_heard appends a bounded diagnostic record with the realtime session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-heard-"));
  const path = join(directory, "heard.jsonl");
  const registry = new ToolRegistry();
  assert.equal(registry.register(recordHeardDeclaration(), recordHeardHandler({ path })), null);
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [RECORD_HEARD_TOOL] }) });
  await runtime.start();
  try {
    const report = await runtime.execute({
      tool: RECORD_HEARD_TOOL,
      requestId: "heard-1",
      sessionId: "session-1",
      args: {
        verbatim: "Y aquí es donde estamos y pronto",
        meaning: "Jaký typ Gemini modelu používáš?",
        language: "cs",
        uncertain_parts: "model",
      },
    });
    assert.deepEqual(report.outcome, { kind: "silent" });
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(record.schema, "debug.heard.v1");
    assert.equal(record.heard_id, "heard-1");
    assert.equal(record.session_id, "session-1");
    assert.equal(record.verbatim, "Y aquí es donde estamos y pronto");
    assert.equal(record.meaning, "Jaký typ Gemini modelu používáš?");
    assert.deepEqual(record.uncertain_parts, ["model"]);
  } finally {
    await runtime.stop();
  }
});
