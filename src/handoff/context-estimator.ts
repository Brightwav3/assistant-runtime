/**
 * Runtime-measured context estimation.
 *
 * The trigger is measured here rather than read off the provider, because realtime
 * providers do not reliably announce that a limit is near — and a runtime that waits to be
 * told will be told too late, or not at all.
 *
 * Two deliberate biases, both in the same direction:
 *
 * The characters-per-token divisor is smaller than a real tokenizer's average, so the
 * estimate reports more tokens than there are. Over-estimating costs an early handoff;
 * under-estimating costs the conversation. Only one of those is recoverable.
 *
 * Audio is counted, not ignored. A voice conversation's context is mostly audio, and an
 * estimator that counted only transcripts would read a session as nearly empty right up
 * until the provider terminated it.
 */

export interface ContextEstimate {
  tokens: number;
  limit: number;
  /** `tokens / limit`, clamped to [0, 1]. */
  ratio: number;
}

export type ContextTurnRole = "user" | "assistant" | "tool" | "delegation" | "system";

export interface ContextEstimatorOptions {
  limitTokens: number;
  /** Deliberately below a real tokenizer's average so the estimate errs high. */
  charactersPerToken?: number;
  /** Framing cost of a turn boundary, independent of its length. */
  perTurnOverheadTokens?: number;
  /** Audio is billed against the context window by duration, not by size on the wire. */
  audioTokensPerSecond?: number;
}

const DEFAULT_CHARACTERS_PER_TOKEN = 3;
const DEFAULT_PER_TURN_OVERHEAD_TOKENS = 8;
/** Above the ~25 tokens/second realtime providers document, for the same reason as the divisor. */
const DEFAULT_AUDIO_TOKENS_PER_SECOND = 32;

export interface ContextEstimator {
  record(input: { role: ContextTurnRole; text: string }): void;
  recordAudio(input: { durationMs: number }): void;
  estimate(): ContextEstimate;
  /** Seeds a fresh window, normally with the compacted context a replacement was prefilled with. */
  reset(seed?: { text?: string }): void;
}

export class RuntimeContextEstimator implements ContextEstimator {
  private readonly limit: number;
  private readonly charactersPerToken: number;
  private readonly perTurnOverheadTokens: number;
  private readonly audioTokensPerSecond: number;
  private tokens = 0;

  public constructor(options: ContextEstimatorOptions) {
    if (!Number.isFinite(options.limitTokens) || options.limitTokens <= 0) {
      throw new Error("context estimation requires a positive limitTokens.");
    }
    this.limit = options.limitTokens;
    this.charactersPerToken = options.charactersPerToken ?? DEFAULT_CHARACTERS_PER_TOKEN;
    this.perTurnOverheadTokens = options.perTurnOverheadTokens ?? DEFAULT_PER_TURN_OVERHEAD_TOKENS;
    this.audioTokensPerSecond = options.audioTokensPerSecond ?? DEFAULT_AUDIO_TOKENS_PER_SECOND;
  }

  public record(input: { role: ContextTurnRole; text: string }): void {
    this.tokens += this.perTurnOverheadTokens + Math.ceil(input.text.length / this.charactersPerToken);
  }

  public recordAudio(input: { durationMs: number }): void {
    if (!(input.durationMs > 0)) return;
    this.tokens += Math.ceil((input.durationMs / 1000) * this.audioTokensPerSecond);
  }

  public estimate(): ContextEstimate {
    return { tokens: this.tokens, limit: this.limit, ratio: Math.min(1, this.tokens / this.limit) };
  }

  public reset(seed?: { text?: string }): void {
    this.tokens = 0;
    if (seed?.text) this.record({ role: "system", text: seed.text });
  }

  /** How much room is left before the limit, in the same units the estimate reports. */
  public headroomTokens(): number { return Math.max(0, this.limit - this.tokens); }
}

/**
 * Fires once when the estimate crosses the prepare threshold.
 *
 * Latched on purpose. Without it every subsequent turn re-crosses the threshold and asks
 * for another handoff, and the runtime spends the rest of the conversation opening
 * replacement sessions it never commits.
 */
export class ContextThresholdTrigger {
  private armed = true;

  public constructor(
    private readonly estimator: ContextEstimator,
    private readonly threshold: number,
  ) {
    if (!(threshold > 0 && threshold < 1)) throw new Error("handoff.prepareThreshold must be within (0, 1).");
  }

  /** Returns true at most once per arming, at the moment the threshold is first crossed. */
  public observe(): boolean {
    if (!this.armed) return false;
    if (this.estimator.estimate().ratio < this.threshold) return false;
    this.armed = false;
    return true;
  }

  /** Re-arms for the next window. Called after a commit, alongside the estimator reset. */
  public rearm(): void { this.armed = true; }

  public isArmed(): boolean { return this.armed; }
}
