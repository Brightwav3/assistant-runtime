/**
 * Bounded metrics for the handoff path.
 *
 * Bounded literally: counters and running aggregates, never a growing array of samples. A
 * long-running assistant is exactly the process where an unbounded metric buffer is a leak
 * that only shows up after the conversations this feature exists to enable.
 *
 * Compaction *cost* is not aggregated here. It is already separated by role in the usage
 * meter, and a second copy of a number is a second thing that can disagree with the first.
 */

import type { HandoffEvent, HandoffFailureReason } from "./contracts.js";

export interface DurationSummary { count: number; total: number; min?: number; max?: number; average?: number }

export interface HandoffMetricsSnapshot {
  prepareLatencyMs: DurationSummary;
  waitForIdleMs: DurationSummary;
  overlapMs: DurationSummary;
  prepares: number;
  commits: number;
  aborts: number;
  abortsByReason: Record<string, number>;
  compactionsStarted: number;
  compactionsCompleted: number;
  compactionsFailed: number;
  /** Aborts as a fraction of attempts. `undefined` before the first attempt, not zero. */
  abortRate?: number;
}

class Durations {
  private count = 0;
  private total = 0;
  private minimum?: number;
  private maximum?: number;

  public add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.total += value;
    this.minimum = this.minimum === undefined ? value : Math.min(this.minimum, value);
    this.maximum = this.maximum === undefined ? value : Math.max(this.maximum, value);
  }

  public snapshot(): DurationSummary {
    return {
      count: this.count,
      total: this.total,
      ...(this.minimum === undefined ? {} : { min: this.minimum }),
      ...(this.maximum === undefined ? {} : { max: this.maximum }),
      ...(this.count ? { average: this.total / this.count } : {}),
    };
  }
}

export class HandoffMetrics {
  private readonly prepareLatency = new Durations();
  private readonly waitForIdle = new Durations();
  private readonly overlap = new Durations();
  private readonly abortsByReason = new Map<HandoffFailureReason | string, number>();
  private prepares = 0;
  private commits = 0;
  private aborts = 0;
  private compactionsStarted = 0;
  private compactionsCompleted = 0;
  private compactionsFailed = 0;
  private preparedAtMs?: number;
  private readyAtMs?: number;

  /** Subscribe this to the coordinator's event stream. */
  public handle(event: HandoffEvent): void {
    const at = Date.parse(event.occurredAt);
    switch (event.type) {
      case "handoff.prepared":
        this.prepares += 1;
        this.preparedAtMs = at;
        this.readyAtMs = undefined;
        return;
      case "handoff.ready":
        if (this.preparedAtMs !== undefined) this.prepareLatency.add(at - this.preparedAtMs);
        this.readyAtMs = at;
        return;
      case "handoff.committed":
        this.commits += 1;
        if (this.readyAtMs !== undefined) this.waitForIdle.add(at - this.readyAtMs);
        this.overlap.add(event.overlapMs);
        this.clearAttempt();
        return;
      case "handoff.aborted":
      case "handoff.failed":
        this.aborts += 1;
        this.abortsByReason.set(event.failure, (this.abortsByReason.get(event.failure) ?? 0) + 1);
        this.clearAttempt();
        return;
      case "compaction.started": this.compactionsStarted += 1; return;
      case "compaction.completed": this.compactionsCompleted += 1; return;
      case "compaction.failed": this.compactionsFailed += 1; return;
      default: return;
    }
  }

  public snapshot(): HandoffMetricsSnapshot {
    const attempts = this.commits + this.aborts;
    return {
      prepareLatencyMs: this.prepareLatency.snapshot(),
      waitForIdleMs: this.waitForIdle.snapshot(),
      overlapMs: this.overlap.snapshot(),
      prepares: this.prepares,
      commits: this.commits,
      aborts: this.aborts,
      abortsByReason: Object.fromEntries(this.abortsByReason),
      compactionsStarted: this.compactionsStarted,
      compactionsCompleted: this.compactionsCompleted,
      compactionsFailed: this.compactionsFailed,
      ...(attempts ? { abortRate: this.aborts / attempts } : {}),
    };
  }

  private clearAttempt(): void {
    this.preparedAtMs = undefined;
    this.readyAtMs = undefined;
  }
}
