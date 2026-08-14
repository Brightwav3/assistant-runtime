import { EpisodeRuntime } from "memory-core";
import type { RealtimeSpeechEvent } from "realtime-core";
import type { MemoryExtractionInput, MemoryExtractionTurn } from "intelligence-core";
import type { MemoryExtractionOrchestrator } from "./memory-extraction.js";

export interface EpisodeMemoryWriterOptions {
  episodes: EpisodeRuntime;
  subjectId: string;
  outputTranscriptMode?: "delta" | "cumulative";
  extractor?: MemoryExtractionOrchestrator;
  trace?: (event: Record<string, unknown>) => void;
}

/** Converts realtime lifecycle events into bounded textual episode records. Raw audio is never accepted. */
export class EpisodeMemoryWriter {
  private readonly episodes: EpisodeRuntime;
  private readonly subjectId: string;
  private readonly outputTranscriptMode: "delta" | "cumulative";
  private readonly extractor?: MemoryExtractionOrchestrator;
  private readonly trace: (event: Record<string, unknown>) => void;
  private readonly pendingOutput = new Map<string, { turnId: string; text: string }>();
  private readonly knownSessions = new Set<string>();
  private readonly closedSessions = new Set<string>();
  private readonly turns = new Map<string, MemoryExtractionTurn[]>();
  private queue = Promise.resolve();

  public constructor(options: EpisodeMemoryWriterOptions) {
    this.episodes = options.episodes;
    this.subjectId = options.subjectId;
    this.outputTranscriptMode = options.outputTranscriptMode ?? "delta";
    this.extractor = options.extractor;
    this.trace = options.trace ?? (() => {});
  }

  public handle(event: RealtimeSpeechEvent): Promise<void> {
    this.queue = this.queue.then(() => this.process(event));
    return this.queue;
  }

  public async flush(): Promise<void> {
    await this.queue;
    for (const sessionId of [...this.knownSessions]) {
      if (this.closedSessions.has(sessionId)) continue;
      await this.finish(sessionId, "completed");
    }
  }

  private async process(event: RealtimeSpeechEvent): Promise<void> {
    const sessionId = event.sessionId;
    if (this.closedSessions.has(sessionId)) return;
    if (event.type === "session.started") {
      await this.ensureSession(sessionId);
      return;
    }
    if (event.type === "transcript.final" && event.source === "input") {
      await this.ensureSession(sessionId);
      const turn = await this.episodes.appendTurn(sessionId, { speaker: "user", text: event.text, status: "complete" });
      if (turn) this.recordTurn(sessionId, turn.turnId, "user", turn.text, turn.status);
      return;
    }
    if ((event.type === "transcript.partial" || event.type === "transcript.final") && event.source === "output") {
      await this.ensureSession(sessionId);
      await this.appendOutput(sessionId, event.text, event.type === "transcript.final");
      return;
    }
    if (event.type === "output.interrupted") {
      const output = this.pendingOutput.get(sessionId);
      if (output) {
        const turn = await this.episodes.completeTurn(output.turnId, "interrupted");
        if (turn) this.recordTurn(sessionId, turn.turnId, "assistant", turn.text, turn.status);
        this.pendingOutput.delete(sessionId);
      }
      return;
    }
    if (event.type === "output.audio_completed") {
      const output = this.pendingOutput.get(sessionId);
      if (output) {
        const turn = await this.episodes.completeTurn(output.turnId, "complete");
        if (turn) this.recordTurn(sessionId, turn.turnId, "assistant", turn.text, turn.status);
        this.pendingOutput.delete(sessionId);
      }
      return;
    }
    if (event.type === "session.closed" || event.type === "session.error") {
      await this.finish(sessionId, event.type === "session.error" ? "failed" : "completed");
    }
  }

  private async ensureSession(sessionId: string): Promise<void> {
    if (this.knownSessions.has(sessionId)) return;
    await this.episodes.startSession({ sessionId, subjectId: this.subjectId });
    this.knownSessions.add(sessionId);
    this.turns.set(sessionId, []);
  }

  private async appendOutput(sessionId: string, text: string, final: boolean): Promise<void> {
    const pending = this.pendingOutput.get(sessionId);
    const nextText = pending ? this.outputTranscriptMode === "cumulative" ? text : `${pending.text}${text}` : text;
    if (!pending) {
      const turn = await this.episodes.appendTurn(sessionId, { speaker: "assistant", text: nextText, status: final ? "complete" : "partial" });
      if (!turn) return;
      this.pendingOutput.set(sessionId, { turnId: turn.turnId, text: nextText });
      this.recordTurn(sessionId, turn.turnId, "assistant", nextText, turn.status);
    } else {
      await this.episodes.updateTurnText(pending.turnId, nextText);
      pending.text = nextText;
      if (final) {
        const turn = await this.episodes.completeTurn(pending.turnId, "complete");
        if (turn) this.recordTurn(sessionId, turn.turnId, "assistant", turn.text, turn.status);
        this.pendingOutput.delete(sessionId);
      }
    }
  }

  private recordTurn(sessionId: string, turnId: string, speaker: MemoryExtractionTurn["speaker"], text: string, status: MemoryExtractionTurn["status"]): void {
    const turns = this.turns.get(sessionId) ?? [];
    const existing = turns.find((turn) => turn.turnId === turnId);
    if (existing) { existing.text = text; existing.status = status; } else turns.push({ turnId, speaker, text, status });
    this.turns.set(sessionId, turns);
  }

  private async finish(sessionId: string, status: "completed" | "failed"): Promise<void> {
    if (this.closedSessions.has(sessionId)) return;
    const output = this.pendingOutput.get(sessionId);
    if (output) {
      const turn = await this.episodes.completeTurn(output.turnId, status === "failed" ? "interrupted" : "complete");
      if (turn) this.recordTurn(sessionId, turn.turnId, "assistant", turn.text, turn.status);
      this.pendingOutput.delete(sessionId);
    }
    const session = await this.episodes.endSession(sessionId, status);
    this.closedSessions.add(sessionId);
    if (this.extractor) {
      const input: MemoryExtractionInput = { subjectId: this.subjectId, sessionId: session.sessionId, turns: this.turns.get(sessionId) ?? [] };
      try { await this.extractor.process(input); } catch (error) { this.trace({ type: "memory.extraction.failed", sessionId, message: error instanceof Error ? error.message : String(error) }); }
    }
    this.trace({ type: "memory.episode.closed", sessionId, status });
  }
}
