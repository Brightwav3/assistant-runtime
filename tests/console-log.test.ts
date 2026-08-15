import assert from "node:assert/strict";
import test from "node:test";
import { createHumanTrace } from "../src/console-log.js";

test("human trace hides high-volume metrics and prints a complete assistant answer", () => {
  const lines: string[] = [];
  const trace = createHumanTrace((line) => lines.push(line));

  trace({ type: "realtime.input.metrics", framesSent: 3_025, framesDropped: 0, bufferedMs: 0 });
  trace({ type: "realtime.transcript.partial", source: "output", text: "Dobrý den," });
  trace({ type: "realtime.transcript.partial", source: "output", text: " jsem připraven." });
  trace({ type: "realtime.output.audio_completed" });

  assert.deepEqual(lines, ["Gemini: Dobrý den, jsem připraven."]);
});

test("human trace keeps lifecycle, input, and tool messages readable", () => {
  const lines: string[] = [];
  const trace = createHumanTrace((line) => lines.push(line));

  trace({ type: "realtime.tools.discovered", count: 2, tools: ["calculate", "get_time"] });
  trace({ type: "activation.detected" });
  trace({ type: "realtime.connect.succeeded" });
  trace({ type: "realtime.transcript.final", source: "input", text: "Kolik je dva plus dva?" });
  trace({ type: "realtime.tool.requested", tool: "calculate" });
  trace({ type: "realtime.tool.metrics", completed: 1, failed: 0, cancelled: 0 });

  assert.deepEqual(lines, [
    "Nástroje: calculate, get_time.",
    "Aktivace zachycena.",
    "Gemini připojeno.",
    "Slyšel jsem: Kolik je dva plus dva?",
    "Používám nástroj: calculate.",
    "Nástroj dokončen.",
  ]);
});

test("human trace summarizes handoff, compaction, memory closure, and the raw trace path", () => {
  const lines: string[] = [];
  const trace = createHumanTrace((line) => lines.push(line));

  trace({ type: "debug.trace.started", path: "C:\\runtime\\traces\\trace-1.jsonl" });
  trace({ type: "handoff.prepared" });
  trace({ type: "compaction.started" });
  trace({ type: "compaction.completed" });
  trace({ type: "handoff.ready" });
  trace({ type: "handoff.committed" });
  trace({ type: "memory.episode.closed" });
  trace({ type: "delegation.failed", failure: { code: "DELEGATION_RESULT_INVALID" } });
  trace({ type: "debug.trace.closed", path: "C:\\runtime\\traces\\trace-1.jsonl" });

  assert.deepEqual(lines, [
    "Raw trace: C:\\runtime\\traces\\trace-1.jsonl",
    "Handoff: příprava…",
    "Compaction: probíhá…",
    "Compaction: dokončena.",
    "Handoff: připraven.",
    "Handoff: přepnuto.",
    "Paměť: epizoda uzavřena.",
    "Delegace selhala: DELEGATION_RESULT_INVALID.",
    "Raw trace uložen: C:\\runtime\\traces\\trace-1.jsonl",
  ]);
});
