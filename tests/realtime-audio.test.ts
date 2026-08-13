import assert from "node:assert/strict";
import test from "node:test";
import { PcmInputFrameizer } from "../src/realtime-audio.js";

test("splits a 100 ms capture chunk into five 20 ms frames", () => {
  const frameizer = new PcmInputFrameizer(320);
  const frames = frameizer.push(new Int16Array(1_600).fill(7));
  assert.equal(frames.length, 5);
  assert.deepEqual(frames.map((frame) => frame.length), [320, 320, 320, 320, 320]);
  assert.ok(frames.every((frame) => frame.every((sample) => sample === 7)));
});

test("carries partial samples and copies the source", () => {
  const frameizer = new PcmInputFrameizer(320);
  const source = new Int16Array(400).fill(3);
  const first = frameizer.push(source);
  source.fill(9);
  const second = frameizer.push(new Int16Array(240).fill(4));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.[0], 3);
  assert.equal(second[0]?.[319], 4);
});
