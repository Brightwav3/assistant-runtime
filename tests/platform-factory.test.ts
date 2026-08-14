import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantRuntime } from "../src/composition.js";
import { createPlatformServices, normalizePlatform } from "../src/platform/factory.js";
import { PlatformUnsupportedError } from "../src/platform/contracts.js";
import type { RuntimeSettings } from "../src/config.js";

// No microphone, speaker, API key, or network is touched by anything in this file.

const settingsFor = (path: string): RuntimeSettings => ({
  assistantId: "assistant.platform.test",
  mode: "native_realtime",
  inactivityMs: 1000,
  activation: { provider: "double_clap", sourceId: "test-microphone", minimumIntervalMs: 100, maximumIntervalMs: 700, amplitudeThreshold: 0.1 },
  realtime: { provider: "gemini", inputSampleRate: 16000, outputSampleRate: 24000 },
  memory: { enabled: false, path, scopeSubjectId: "test-user" },
  state: { enabled: false },
});

test("normalizePlatform only recognises the three supported host families", () => {
  assert.equal(normalizePlatform("win32"), "win32");
  assert.equal(normalizePlatform("darwin"), "darwin");
  assert.equal(normalizePlatform("linux"), "linux");
  assert.equal(normalizePlatform("aix"), "unknown");
});

test("the Windows leaf reports itself supported and names a concrete player", () => {
  const platform = createPlatformServices("win32");
  assert.equal(platform.id, "win32");
  assert.equal(platform.capability.status, "supported");
  assert.ok(platform.player.executable.length > 0);
  assert.ok(platform.player.args(24_000).includes("s16le"));
});

for (const id of ["darwin", "linux"] as const) {
  test(`the ${id} leaf reports unsupported instead of faking hardware`, () => {
    const platform = createPlatformServices(id);
    assert.equal(platform.id, id);
    assert.equal(platform.capability.status, "unsupported");
    // Break caught: a placeholder that reports "supported" would let the runtime
    // claim a microphone it does not have.
    assert.ok(platform.capability.reason, "an unsupported platform must explain why");
    assert.throws(() => platform.createSpeechStack(), PlatformUnsupportedError);
  });
}

test("an unsupported platform degrades the audio components rather than crashing the runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-runtime-platform-"));
  const composition = await createAssistantRuntime(settingsFor(join(directory, "memory.sqlite")), undefined, { platform: createPlatformServices("darwin") });
  try {
    await composition.runtime.start();
    const health = await composition.runtime.health();
    assert.equal(health.components.microphone?.state, "degraded");
    assert.equal(health.components.playback?.state, "degraded");
    assert.ok(health.components.microphone?.detail, "the degraded state must carry a reason");
    const capabilities = await composition.components.find((component) => component.id === "microphone")!.capabilities!();
    assert.equal(capabilities.available, false);
    assert.equal(capabilities.pcmInput, false);
  } finally {
    await composition.runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("modular mode on an unsupported platform reports a degraded modular component", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-runtime-platform-modular-"));
  const composition = await createAssistantRuntime({ ...settingsFor(join(directory, "memory.sqlite")), mode: "modular" }, undefined, { platform: createPlatformServices("linux") });
  try {
    await composition.runtime.start();
    const health = await composition.runtime.health();
    assert.equal(health.components.modular?.state, "degraded");
    // Break caught: falling through to the realtime component would silently
    // change the interaction mode the operator asked for.
    assert.equal(health.components.realtime, undefined);
  } finally {
    await composition.runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("composition never constructs a platform leaf the caller did not select", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-runtime-platform-inject-"));
  const composition = await createAssistantRuntime(settingsFor(join(directory, "memory.sqlite")), undefined, { platform: createPlatformServices("darwin") });
  try {
    assert.equal(composition.platform.id, "darwin");
  } finally {
    await composition.runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
