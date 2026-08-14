import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { verifyPlayback } from "../src/adapters.js";
import { createPlatformServices } from "../src/platform/factory.js";

const windowsPlayer = createPlatformServices("win32").player;
const playerInstalled = spawnSync(windowsPlayer.executable, ["-version"], { windowsHide: true }).status === 0;

// Regression guard: ffplay 8 removed the -ar/-ac shorthands, which silently killed playback mid-greeting.
// This exercises the real executable with the exact production arguments so a future flag removal fails the suite.
test("the installed player accepts the production playback arguments", { skip: playerInstalled ? false : `${windowsPlayer.executable} is not installed` }, async () => {
  const result = await verifyPlayback(windowsPlayer);
  assert.equal(result.ok, true, result.message);
});

test("playback arguments carry an explicit raw PCM format", () => {
  const args = windowsPlayer.args(24_000);
  for (const flag of ["-f", "-sample_rate", "-ch_layout", "-i"]) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.equal(args[args.indexOf("-sample_rate") + 1], "24000");
});

test("preflight reports a diagnosable failure instead of dying silently", async () => {
  const result = await verifyPlayback({ executable: "definitely-not-a-real-player.exe", args: windowsPlayer.args });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /could not be started/);
});

test("preflight refuses without a player rather than probing another host's executable", async () => {
  // Break caught: defaulting to ffplay.exe made a macOS/Linux preflight spawn a
  // Windows binary and report a misleading "not installed" diagnosis.
  const result = await verifyPlayback(undefined);
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /No platform leaf supplied a PCM player/);
  assert.doesNotMatch(result.message ?? "", /ffplay/);
});

test("an unsupported platform exposes no player executable at all", () => {
  for (const id of ["darwin", "linux"] as const) {
    const player = createPlatformServices(id).player;
    assert.equal(player.executable, "");
    assert.deepEqual(player.args(24_000), []);
  }
});
