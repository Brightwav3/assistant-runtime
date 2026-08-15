/**
 * The handoff state machine.
 *
 * One attempt runs at a time and reaches exactly one terminal outcome. That property is
 * not decoration: a half-committed handoff leaves two live sessions against one
 * microphone, which is the one failure the user would hear immediately.
 *
 * The terminal outcome is claimed synchronously, before any side effect, for the same
 * reason the Delegation Broker claims it before cancelling a handle — an await between
 * "decide" and "act" is a window for a second outcome to be published.
 */

import {
  HandoffError,
  type HandoffContextSource,
  type HandoffEvent,
  type HandoffFailureReason,
  type HandoffIdentity,
  type HandoffPhase,
  type HandoffReason,
  type HandoffSessionController,
} from "./contracts.js";
import { waitForIdle, type HandoffIdleGate } from "./idle-gate.js";

export interface HandoffCoordinatorOptions {
  logicalSessionId: string;
  activePhysicalSessionId: string;
  controller: HandoffSessionController;
  context: HandoffContextSource;
  emit?: (event: HandoffEvent) => void;
  /** A replacement that has not acknowledged its context by now is abandoned, not committed. */
  readyTimeoutMs?: number;
  /** Reports when the conversation has a gap. Without one, `commitWhenIdle` commits immediately. */
  idle?: HandoffIdleGate;
  /** How long to wait for that gap before giving up on the attempt. */
  idleWaitTimeoutMs?: number;
  clock?: () => string;
  now?: () => number;
}

interface Attempt {
  reason: HandoffReason;
  replacementId: string | undefined;
  previousId: string;
  startedAtMs: number;
  terminal: boolean;
}

export class HandoffCoordinator {
  private readonly controller: HandoffSessionController;
  private readonly context: HandoffContextSource;
  private readonly clock: () => string;
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;
  private readonly idleWaitTimeoutMs: number;
  private phaseValue: HandoffPhase = "idle";
  private logicalSessionId: string;
  private activePhysicalSessionId: string;
  private attempt?: Attempt;

  public constructor(private readonly options: HandoffCoordinatorOptions) {
    this.controller = options.controller;
    this.context = options.context;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.now = options.now ?? (() => Date.now());
    this.readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
    this.idleWaitTimeoutMs = options.idleWaitTimeoutMs ?? 30_000;
    this.logicalSessionId = options.logicalSessionId;
    this.activePhysicalSessionId = options.activePhysicalSessionId;
  }

  public phase(): HandoffPhase { return this.phaseValue; }

  public identity(): HandoffIdentity {
    return {
      logicalSessionId: this.logicalSessionId,
      activePhysicalSessionId: this.activePhysicalSessionId,
      ...(this.attempt?.replacementId && !this.attempt.terminal ? { replacementPhysicalSessionId: this.attempt.replacementId } : {}),
    };
  }

  /**
   * Opens a replacement and prefills it. Returns once the attempt has reached `ready` or
   * has already aborted — never leaving the caller to guess which.
   */
  public async prepare(reason: HandoffReason): Promise<void> {
    if (this.phaseValue !== "idle") throw new HandoffError("HANDOFF_IN_PROGRESS", "A handoff attempt is already running.");
    const attempt: Attempt = { reason, replacementId: undefined, previousId: this.activePhysicalSessionId, startedAtMs: this.now(), terminal: false };
    this.attempt = attempt;
    this.phaseValue = "prepare";

    let replacementId: string;
    try {
      replacementId = await this.controller.open();
    } catch {
      await this.abort("PROVIDER_DISCONNECTED");
      return;
    }
    attempt.replacementId = replacementId;
    if (attempt.terminal) return;
    this.emit({ type: "handoff.prepared", identity: this.identity(), reason, occurredAt: this.clock() });

    let compacted: string;
    try {
      compacted = await this.context.compact(this.identity());
    } catch {
      await this.abort("COMPACTION_FAILED");
      return;
    }
    if (attempt.terminal) return;

    try {
      await withTimeout(this.controller.prefill(replacementId, compacted), this.readyTimeoutMs);
    } catch {
      // A replacement that never acknowledged its context cannot be committed. Degrading to
      // the session that still works is correct; cutting to a half-prepared one is not.
      await this.abort("REPLACEMENT_NOT_READY");
      return;
    }
    if (attempt.terminal) return;

    this.phaseValue = "ready";
    this.emit({ type: "handoff.ready", identity: this.identity(), reason, occurredAt: this.clock() });
  }

  /**
   * Waits for a gap in the conversation, then commits.
   *
   * The gap is re-checked immediately before the swap. A user who starts speaking between
   * "idle observed" and "commit executed" would otherwise be cut over mid-utterance —
   * the window is small, and it is exactly the window a real interruption lands in.
   */
  public async commitWhenIdle(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) throw new HandoffError("HANDOFF_NOT_STARTED", "No handoff attempt has been prepared.");
    if (attempt.terminal) return;
    if (this.phaseValue !== "ready") throw new HandoffError("HANDOFF_NOT_READY", "The replacement session has not acknowledged its context.");

    const gate = this.options.idle;
    if (!gate) return this.commit();

    const deadline = this.now() + this.idleWaitTimeoutMs;
    while (this.now() < deadline) {
      const remaining = deadline - this.now();
      if (!(await waitForIdle(gate, remaining))) break;
      if (attempt.terminal) return;
      // Re-checked, not assumed: `waitForIdle` resolving means a gap existed, not that one
      // still does by the time this line runs.
      if (gate.isIdle()) return this.commit();
    }

    await this.abort("NO_IDLE_GAP");
  }

  /**
   * Makes the replacement active and tears the previous session down.
   *
   * Idempotent: a retry racing a completion produces one outcome, not two live sessions.
   */
  public async commit(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) throw new HandoffError("HANDOFF_NOT_STARTED", "No handoff attempt has been prepared.");
    if (attempt.terminal) return;
    if (this.phaseValue !== "ready" || !attempt.replacementId) {
      throw new HandoffError("HANDOFF_NOT_READY", "The replacement session has not acknowledged its context.");
    }

    attempt.terminal = true;
    this.phaseValue = "commit";
    const replacementId = attempt.replacementId;
    const previousId = attempt.previousId;

    try {
      // Synchronous by contract: no await may separate the two sessions' ownership.
      this.controller.activate(replacementId);
    } catch {
      this.phaseValue = "idle";
      this.emit({ type: "handoff.failed", identity: this.identity(), reason: attempt.reason, failure: "PROVIDER_DISCONNECTED", occurredAt: this.clock() });
      return;
    }
    this.activePhysicalSessionId = replacementId;

    this.emit({
      type: "handoff.committed",
      identity: { logicalSessionId: this.logicalSessionId, activePhysicalSessionId: replacementId, replacementPhysicalSessionId: replacementId },
      reason: attempt.reason,
      overlapMs: this.now() - attempt.startedAtMs,
      occurredAt: this.clock(),
    });

    this.phaseValue = "teardown";
    await this.controller.close(previousId).catch(() => undefined);
    this.phaseValue = "idle";
  }

  /** Ends the attempt and retains the current session. Reported, never silently retried. */
  public async abort(failure: HandoffFailureReason): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.terminal) return;
    attempt.terminal = true;
    this.phaseValue = "aborted";

    if (attempt.replacementId) await this.controller.close(attempt.replacementId).catch(() => undefined);
    this.emit({ type: "handoff.aborted", identity: this.identity(), reason: attempt.reason, failure, occurredAt: this.clock() });
    this.phaseValue = "idle";
  }

  private emit(event: HandoffEvent): void { this.options.emit?.(event); }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("HANDOFF_READY_TIMEOUT")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
