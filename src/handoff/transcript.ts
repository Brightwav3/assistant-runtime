/**
 * The conversation, held by the runtime rather than by the session.
 *
 * This is the inversion the whole feature rests on: a provider session renders the
 * conversation, it does not own it. A runtime that read the transcript back off the session
 * would have nothing to compact at exactly the moment the session is being replaced.
 *
 * Bounded on purpose. An unbounded record grows for the length of the conversation and is
 * then handed whole to a compaction that exists precisely because context is finite. Dropping
 * the oldest turns is safe here and nowhere else: compaction is never the only writer of a
 * fact, so anything that matters is already in Memory Core.
 */

import type { CompactionTranscriptSource } from "./compaction.js";
import type { ContextTurnRole } from "./context-estimator.js";

export interface TranscriptTurn {
  role: ContextTurnRole;
  text: string;
}

export interface RollingTranscriptOptions {
  /** How many turns to keep. Reached in a long conversation, not a typical one. */
  maxTurns?: number;
}

const DEFAULT_MAX_TURNS = 400;

export class RollingTranscript implements CompactionTranscriptSource {
  private readonly maxTurns: number;
  private readonly recorded: TranscriptTurn[] = [];
  private dropped = 0;

  public constructor(options: RollingTranscriptOptions = {}) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    if (!Number.isFinite(this.maxTurns) || this.maxTurns <= 0) throw new Error("RollingTranscript requires a positive maxTurns.");
  }

  /** Empty and whitespace-only turns are ignored: a blank line is not a turn to summarize. */
  public record(turn: TranscriptTurn): void {
    const text = turn.text.trim();
    if (!text) return;
    this.recorded.push({ role: turn.role, text });
    while (this.recorded.length > this.maxTurns) {
      this.recorded.shift();
      this.dropped += 1;
    }
  }

  public turns(): TranscriptTurn[] { return [...this.recorded]; }

  /** How many turns fell off the back. Reported, so a truncated compaction is never silent. */
  public droppedTurns(): number { return this.dropped; }

  /**
   * Starts the record the replacement session actually holds.
   *
   * Seeded with the compacted context for the same reason the estimator is: the new window
   * contains that summary, so the next compaction must summarize the summary and what
   * followed it, not the conversation the replaced session was carrying.
   */
  public reset(seed?: { text?: string }): void {
    this.recorded.length = 0;
    if (seed?.text) this.record({ role: "system", text: seed.text });
  }
}
