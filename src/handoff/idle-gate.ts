/**
 * When it is safe to swap sessions.
 *
 * We cannot cut over mid-generation — as an API client we have no access to the provider's
 * inference state — but we do not need to, because a real conversation produces a gap
 * within seconds. A gap is a cheaper cutover point than any amount of parallel inference.
 *
 * "Idle" means both directions are quiet. The assistant not speaking is not enough: cutting
 * over while the user is mid-sentence loses the half of the utterance the old session
 * already received, and the replacement answers a fragment.
 */

export interface HandoffIdleGate {
  isIdle(): boolean;
  /** Fires whenever the session becomes idle. Returns an unsubscribe function. */
  onIdle(listener: () => void): () => void;
}

/** The output half of the gate — satisfied by `DelegationDeliveryScheduler`. */
export interface OutputIdleSource {
  isIdle(sessionId: string): boolean;
  onIdle(sessionId: string, listener: () => void): () => void;
}

/**
 * Composes the assistant's output state with the user's turn state.
 *
 * The output half is the delivery scheduler's, unchanged — a handoff and a `when_idle`
 * delivery are asking the same question, and the workplan is explicit that forking that
 * mechanism is the failure to avoid.
 */
export class SessionIdleGate implements HandoffIdleGate {
  private userSpeaking = false;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeOutput: () => void;

  public constructor(private readonly output: OutputIdleSource, private readonly sessionId: string) {
    this.unsubscribeOutput = output.onIdle(sessionId, () => this.notify());
  }

  public isIdle(): boolean { return !this.userSpeaking && this.output.isIdle(this.sessionId); }

  public onIdle(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public markUserSpeechStarted(): void { this.userSpeaking = true; }

  public markUserSpeechFinished(): void {
    if (!this.userSpeaking) return;
    this.userSpeaking = false;
    this.notify();
  }

  public dispose(): void {
    this.unsubscribeOutput();
    this.listeners.clear();
  }

  private notify(): void {
    if (!this.isIdle()) return;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Resolves `true` on the first gap, or `false` if the deadline passes first.
 *
 * A session that never goes idle must abort rather than wait forever or cut mid-speech.
 * Waiting forever is the quieter failure and the worse one: the conversation dies at the
 * context limit with no trace of the attempt that was still pending.
 */
export function waitForIdle(gate: HandoffIdleGate, timeoutMs: number): Promise<boolean> {
  if (gate.isIdle()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (idle: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(idle);
    };
    // Not unref'd: a session that never goes idle is exactly the case where this
    // deadline is the only thing left on the loop, and an unref'd timer would let
    // the loop drain before it fires — so the wait would never resolve. `finish`
    // clears it on both paths, so it cannot outlive the wait it bounds.
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = gate.onIdle(() => finish(true));
  });
}
