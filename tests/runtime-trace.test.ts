import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunTrace } from "../src/runtime-trace.js";

test("each run gets a unique raw JSONL trace and preserves event order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-runtime-trace-"));
  try {
    const now = new Date("2026-08-15T13:30:12.000Z");
    const first = await createRunTrace(directory, now);
    const second = await createRunTrace(directory, now);

    first.record({ type: "handoff.prepared", sequence: 1 });
    first.record({ type: "handoff.committed", sequence: 2 });
    await first.close();
    await second.close();

    assert.notEqual(first.path, second.path);
    assert.match(first.path, /trace-20260815-153012\.jsonl$/);
    assert.match(second.path, /trace-20260815-153012-02\.jsonl$/);
    assert.deepEqual(
      (await readFile(first.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
      [
        { type: "handoff.prepared", sequence: 1 },
        { type: "handoff.committed", sequence: 2 },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
