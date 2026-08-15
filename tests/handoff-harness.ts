/**
 * A session controller built on the fake realtime provider.
 *
 * It exists so the handoff tests exercise the same contract the real wiring will: open a
 * replacement, prefill it, swap ownership synchronously, close the old one. Audio is only
 * ever sent through `speak`, which routes to whichever session is active — so a test that
 * asserts frame counts is asserting the ownership invariant, not a bookkeeping variable.
 */

import { randomUUID } from "node:crypto";
import { FakeRealtimeSpeechProvider, REALTIME_INPUT_FORMAT, RealtimeCore } from "realtime-core";
import type { AudioFrame } from "realtime-core";
import type { HandoffContextSource, HandoffEvent, HandoffIdentity, HandoffSessionController } from "../src/handoff/contracts.js";

export interface HarnessOptions {
  deferContextAck?: boolean;
  /** Fails the nth `open` call (1-based), modelling a provider that will not give us a session. */
  failOpenAt?: number;
  /** Throws from `activate`, modelling a transport that died between ready and commit. */
  failActivate?: boolean;
  compact?: (identity: HandoffIdentity) => Promise<string>;
}

export interface Harness {
  provider: FakeRealtimeSpeechProvider;
  controller: HandoffSessionController;
  context: HandoffContextSource;
  events: HandoffEvent[];
  initialSessionId: string;
  /** Sends one frame to whichever session currently owns audio. */
  speak(): Promise<void>;
  activeSessionId(): string;
  openSessionIds(): string[];
  /** Kills the transport under a session without telling the controller — a provider disconnect. */
  killSession(physicalSessionId: string): Promise<void>;
  frameCounts(): Record<string, number>;
  compactCalls: number;
}

const frame = (): AudioFrame => ({ streamId: randomUUID(), timestampMs: 0, format: REALTIME_INPUT_FORMAT, data: new Int16Array(320) });

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const provider = new FakeRealtimeSpeechProvider({
    contextInjection: true,
    toolCalling: "async",
    ...(options.deferContextAck ? { deferContextAck: true } : {}),
  });
  // The real multi-session Realtime Core, not a stand-in: the ownership invariant is only
  // worth asserting against the code that will actually hold the sessions.
  const core = new RealtimeCore(provider);
  const events: HandoffEvent[] = [];

  const connect = async (): Promise<string> => (await core.open({ provider: "fake", inputFormat: REALTIME_INPUT_FORMAT })).id;

  const initialSessionId = await connect();
  core.activate(initialSessionId);
  let opens = 0;

  const harness: Harness = {
    provider,
    events,
    initialSessionId,
    compactCalls: 0,
    controller: {
      async open(): Promise<string> {
        opens += 1;
        if (options.failOpenAt === opens) throw new Error("PROVIDER_UNAVAILABLE");
        return connect();
      },
      async prefill(physicalSessionId: string, context: string): Promise<void> {
        const session = core.sessions().find((handle) => handle.id === physicalSessionId)?.session;
        if (!session?.sendContextEvent) throw new Error("CONTEXT_INJECTION_UNAVAILABLE");
        await session.sendContextEvent({
          eventId: `ctx_${randomUUID()}`,
          sessionId: physicalSessionId,
          source: "system",
          type: "system.event",
          status: "completed",
          delivery: "silent",
          content: { type: "text", text: context },
          timestampMs: 0,
        });
      },
      activate(physicalSessionId: string): void {
        if (options.failActivate) throw new Error("CONNECTION_FAILED");
        core.activate(physicalSessionId);
      },
      async close(physicalSessionId: string): Promise<void> {
        await core.close(physicalSessionId);
      },
    },
    context: {
      async compact(identity: HandoffIdentity): Promise<string> {
        harness.compactCalls += 1;
        if (options.compact) return options.compact(identity);
        return "compacted context";
      },
    },
    async speak(): Promise<void> {
      const active = core.active();
      if (!active) throw new Error("no session owns audio");
      await active.session.sendAudio(frame());
    },
    activeSessionId: () => core.active()?.id ?? "",
    openSessionIds: () => core.sessions().map((handle) => handle.id),
    async killSession(physicalSessionId: string): Promise<void> {
      await provider.sessions().find((session) => session.id === physicalSessionId)?.close();
    },
    frameCounts: () => provider.audioFrameCounts(),
  };

  return harness;
}

/**
 * The invariant the whole design rests on: exactly one session owns audio at this instant.
 *
 * Proven by sending a frame and checking that exactly one session's count moved. A
 * counter that is merely read cannot catch a controller that routes to both.
 */
export async function assertSoleAudioOwner(harness: Harness, assert: typeof import("node:assert/strict")): Promise<void> {
  const before = harness.frameCounts();
  await harness.speak();
  const after = harness.frameCounts();
  const moved = Object.keys(after).filter((id) => (after[id] ?? 0) !== (before[id] ?? 0));
  assert.deepEqual(moved, [harness.activeSessionId()], "exactly one session must receive audio, and it must be the active one");
}
