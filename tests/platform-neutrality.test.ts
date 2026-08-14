import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { REALTIME_MICROPHONE_STREAM_ID } from "../src/realtime-audio.js";
import { resolveConfigPath } from "../src/config.js";
import { createAssistantRuntime } from "../src/composition.js";
import { createPlatformServices } from "../src/platform/factory.js";
import type { RuntimeSettings } from "../src/config.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the shared realtime capture stream id names no operating system", () => {
  // Break caught: "windows-default-microphone" leaked a host name into every
  // realtime frame the assistant sent, including on hosts that are not Windows.
  assert.doesNotMatch(REALTIME_MICROPHONE_STREAM_ID, /windows|darwin|linux|macos/i);
  assert.equal(REALTIME_MICROPHONE_STREAM_ID, "local-default-microphone");
});

test("the shipped runtime defaults name no operating system", async () => {
  const settings = JSON.parse(await readFile(join(packageRoot, "config.example.json"), "utf8")) as RuntimeSettings;
  assert.doesNotMatch(settings.activation.sourceId, /windows|darwin|linux|macos/i);
});

test("shared runtime source carries no Windows-only microphone identifier", async () => {
  for (const file of ["src/config.ts", "src/realtime-audio.ts", "src/composition.ts", "src/modular.ts", "src/adapters.ts"]) {
    const source = await readFile(join(packageRoot, file), "utf8");
    assert.doesNotMatch(source, /windows-default-microphone/i, `${file} still names a Windows-only microphone`);
  }
});

test("shared realtime code does not name the Windows player", async () => {
  const source = await readFile(join(packageRoot, "src/adapters.ts"), "utf8");
  // The deprecated re-export line is allowed to mention the leaf module; no
  // executable literal may survive in shared code.
  assert.doesNotMatch(source, /"ffplay\.exe"/, "adapters.ts still hardcodes the Windows playback executable");
});

test("config path precedence is explicit argument, ASSISTANT_CONFIG, JARVIS_CONFIG, then config.json", () => {
  const cwd = "/workdir";
  assert.equal(resolveConfigPath({ ASSISTANT_CONFIG: "/a.json", JARVIS_CONFIG: "/legacy.json" }, cwd), "/a.json");
  assert.equal(resolveConfigPath({ JARVIS_CONFIG: "/legacy.json" }, cwd), "/legacy.json");
  assert.match(resolveConfigPath({}, cwd), /config\.json$/);
  // Break caught: an empty variable used to win over the legacy fallback and
  // resolve to an unreadable path.
  assert.equal(resolveConfigPath({ ASSISTANT_CONFIG: "  ", JARVIS_CONFIG: "/legacy.json" }, cwd), "/legacy.json");
});

test("an unsupported host reports no player and starts no playback process", async () => {
  const traces: Record<string, unknown>[] = [];
  const settings: RuntimeSettings = {
    assistantId: "assistant.neutrality.test",
    mode: "native_realtime",
    inactivityMs: 1000,
    activation: { provider: "double_clap", sourceId: "local-default-microphone", minimumIntervalMs: 100, maximumIntervalMs: 700, amplitudeThreshold: 0.1 },
    realtime: { provider: "gemini", inputSampleRate: 16000, outputSampleRate: 24000 },
    memory: { enabled: false, path: join(packageRoot, "unused.sqlite"), scopeSubjectId: "test-user" },
    state: { enabled: false },
    echoCancellation: { enabled: false, processor: "auto" as const, tailMs: 400, maxDelayMs: 1_000, minErleDb: 6, recoveryFrames: 25 },
  };
  const composition = await createAssistantRuntime(settings, (event) => traces.push(event), { platform: createPlatformServices("darwin") });
  try {
    await composition.runtime.start();
    const capabilities = await composition.runtime.componentCapabilities();
    assert.doesNotMatch(JSON.stringify(capabilities), /ffplay/i, "an unsupported host must not advertise the Windows player");
    assert.ok(traces.some((event) => event.type === "platform.unsupported"), "the unsupported platform must be traced");
  } finally { await composition.runtime.stop(); }
});
