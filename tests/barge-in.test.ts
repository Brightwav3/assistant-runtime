import assert from "node:assert/strict";
import test from "node:test";

test("interrupted output aborts the old sink and accepts the next output", async () => {
  const { PcmPlaybackController } = await import("../src/adapters.js") as typeof import("../src/adapters.js") & { PcmPlaybackController: new (factory: () => { write(chunk: Buffer): void; end(): void; abort(): void }) => { handle(event: unknown): void } };
  const sinks = [
    { writes: [] as Buffer[], ended: 0, aborted: 0, write(chunk: Buffer) { this.writes.push(Buffer.from(chunk)); }, end() { this.ended++; }, abort() { this.aborted++; } },
    { writes: [] as Buffer[], ended: 0, aborted: 0, write(chunk: Buffer) { this.writes.push(Buffer.from(chunk)); }, end() { this.ended++; }, abort() { this.aborted++; } },
  ];
  let created = 0;
  const controller = new PcmPlaybackController(() => sinks[created++]!);
  const frame = (outputId: string, value: number) => ({ type: "output.audio_chunk", outputId, frame: { data: new Int16Array([value]) } });
  controller.handle({ type: "output.audio_started", outputId: "old" });
  controller.handle(frame("old", 1));
  controller.handle({ type: "output.interrupted", outputId: "old" });
  controller.handle(frame("old", 2));
  controller.handle({ type: "output.audio_started", outputId: "new" });
  controller.handle(frame("new", 3));
  assert.equal(sinks[0]!.aborted, 1);
  assert.equal(sinks[0]!.writes.length, 1);
  assert.equal(sinks[1]!.writes.length, 1);
  assert.equal(created, 2);
});
