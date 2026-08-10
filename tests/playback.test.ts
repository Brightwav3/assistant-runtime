import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { PCM_PLAYER, verifyPlayback } from "../src/adapters.js";

const playerInstalled = spawnSync(PCM_PLAYER.executable, ["-version"], { windowsHide: true }).status === 0;

// Regression guard: ffplay 8 removed the -ar/-ac shorthands, which silently killed playback mid-greeting.
// This exercises the real executable with the exact production arguments so a future flag removal fails the suite.
test("the installed player accepts the production playback arguments", { skip: playerInstalled ? false : `${PCM_PLAYER.executable} is not installed` }, async () => {
  const result = await verifyPlayback();
  assert.equal(result.ok, true, result.message);
});

test("playback arguments carry an explicit raw PCM format", () => {
  const args = PCM_PLAYER.args(24_000);
  for (const flag of ["-f", "-sample_rate", "-ch_layout", "-i"]) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.equal(args[args.indexOf("-sample_rate") + 1], "24000");
});

test("preflight reports a diagnosable failure instead of dying silently", async () => {
  const original = PCM_PLAYER.executable;
  Object.assign(PCM_PLAYER, { executable: "definitely-not-a-real-player.exe" });
  try {
    const result = await verifyPlayback();
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /could not be started/);
  } finally { Object.assign(PCM_PLAYER, { executable: original }); }
});
