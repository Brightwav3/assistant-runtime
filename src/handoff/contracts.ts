/**
 * The session handoff contract.
 *
 * The runtime holds the conversation; a provider session only renders it. Everything in
 * this file follows from that inversion — a physical session is replaceable, and the
 * logical session id is the thing every downstream consumer keeps referring to.
 *
 * Nothing here warms a provider instance, transfers key-value cache, or cuts over inside
 * a generation. As an API client we have none of those. The cutover is a swap of which
 * session owns the microphone and the speaker, taken during a gap the conversation
 * produced on its own.
 */

export type HandoffPhase = "idle" | "prepare" | "ready" | "commit" | "teardown" | "aborted";

export interface HandoffIdentity {
  /** Stable across the handoff. Delivery queues, correlation ids, traces and usage all key on this. */
  logicalSessionId: string;
  /** The session that currently owns microphone and playback. */
  activePhysicalSessionId: string;
  /** Present from `prepare` until `teardown` completes. */
  replacementPhysicalSessionId?: string;
}

export type HandoffReason = "context_threshold" | "manual";

export type HandoffFailureReason =
  | "COMPACTION_FAILED"
  | "REPLACEMENT_NOT_READY"
  | "NO_IDLE_GAP"
  | "PROVIDER_DISCONNECTED"
  | "RUNTIME_SHUTDOWN";

export interface HandoffEventBase {
  identity: HandoffIdentity;
  reason: HandoffReason;
  occurredAt: string;
}

export type HandoffEvent =
  | ({ type: "handoff.prepared" } & HandoffEventBase)
  | ({ type: "handoff.ready" } & HandoffEventBase)
  | ({ type: "handoff.committed"; overlapMs: number } & HandoffEventBase)
  | ({ type: "handoff.aborted"; failure: HandoffFailureReason } & HandoffEventBase)
  | ({ type: "handoff.failed"; failure: HandoffFailureReason } & HandoffEventBase)
  | { type: "compaction.started"; identity: HandoffIdentity; executionId: string; occurredAt: string }
  | { type: "compaction.completed"; identity: HandoffIdentity; executionId: string; occurredAt: string }
  | { type: "compaction.failed"; identity: HandoffIdentity; executionId: string; failure: HandoffFailureReason; occurredAt: string };

export type HandoffErrorCode =
  | "HANDOFF_NOT_READY"
  | "HANDOFF_IN_PROGRESS"
  | "HANDOFF_NOT_STARTED";

export class HandoffError extends Error {
  public constructor(public readonly code: HandoffErrorCode, message: string) {
    super(message);
    this.name = "HandoffError";
  }
}

/**
 * The runtime's view of session control. Realtime Core exposes open / activate / close and
 * is told nothing about handoff — the phases, thresholds and abort policy live here.
 *
 * `activate` is deliberately synchronous. An `await` between deactivating one session and
 * activating the next is a window in which zero sessions own audio, which is the same
 * defect as two owning it, only quieter.
 */
export interface HandoffSessionController {
  /** Opens a replacement session without giving it audio. Returns its physical id. */
  open(): Promise<string>;
  /** Delivers compacted context and resolves only once the session acknowledges it. */
  prefill(physicalSessionId: string, context: string): Promise<void>;
  activate(physicalSessionId: string): void;
  close(physicalSessionId: string): Promise<void>;
}

/** Produces the context a replacement is prefilled with. Milestone 4 routes this through the broker. */
export interface HandoffContextSource {
  compact(identity: HandoffIdentity): Promise<string>;
}
