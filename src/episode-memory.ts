import { EpisodeRuntime, type EpisodeUncertainPart } from "memory-core";
import type { RealtimeSpeechEvent } from "realtime-core";
import type { MemoryExtractionInput, MemoryExtractionTurn } from "intelligence-core";
import type { MemoryExtractionOrchestrator } from "./memory-extraction.js";

export interface EpisodeMemoryWriterOptions {
  episodes: EpisodeRuntime;
  subjectId: string;
  outputTranscriptMode?: "delta" | "cumulative";
  /**
   * In diagnostic heard mode, the voice-to-voice model is authoritative for what the user
   * meant and for its literal reconstruction. Gemini's provider transcript can be garbage
   * when the input language is not configured, so it must not replace the heard model's
   * understanding. The provider transcript remains trace/estimator evidence only.
   */
  preferHeardInput?: boolean;
  /**
   * Maps a provider session id to the conversation it belongs to. Without it an episode is
   * the session, which stops being true the moment a handoff replaces one: the conversation
   * would be recorded as two episodes and extracted twice, each over half of it.
   */
  resolveConversationId?: (physicalSessionId: string) => string;
  extractor?: MemoryExtractionOrchestrator;
  trace?: (event: Record<string, unknown>) => void;
}

export interface HeardInput {
  heardId: string;
  sessionId: string;
  verbatim: string;
  meaning: string;
  language: string;
  uncertainParts: EpisodeUncertainPart[];
}

/**
 * The Gemini Live provider exposes no input-language knob. Measured on real
 * conversations: the first user turn of a session is reliably mis-detected — Czech
 * rendered phonetically as Spanish, French, or Portuguese — and very short utterances
 * stay wrong even later, while provider detection converges once enough audio has
 * accumulated.
 *
 * The text is still stored, because a wrong transcript is evidence of what went wrong.
 * It is labelled so nothing downstream treats it as a faithful record.
 */
const MINIMUM_RELIABLE_TRANSCRIPT_LENGTH = 12;

export function assessTranscript(input: { text: string; isFirstUserTurn: boolean }): "reliable" | "unreliable" {
  if (input.isFirstUserTurn) return "unreliable";
  return input.text.trim().length < MINIMUM_RELIABLE_TRANSCRIPT_LENGTH ? "unreliable" : "reliable";
}

export function assessHeardInput(input: Pick<HeardInput, "meaning" | "verbatim" | "uncertainParts">): "reliable" | "unreliable" {
  const text = input.meaning.trim() || input.verbatim.trim();
  if (input.uncertainParts.length > 0 || text.length < MINIMUM_RELIABLE_TRANSCRIPT_LENGTH) return "unreliable";
  return "reliable";
}

/** Converts realtime lifecycle events into bounded textual episode records. Raw audio is never accepted. */
export class EpisodeMemoryWriter {
  private readonly episodes: EpisodeRuntime;
  private readonly subjectId: string;
  private readonly outputTranscriptMode: "delta" | "cumulative";
  private readonly preferHeardInput: boolean;
  private readonly resolveConversationId: (physicalSessionId: string) => string;
  private readonly extractor?: MemoryExtractionOrchestrator;
  private readonly trace: (event: Record<string, unknown>) => void;
  private readonly pendingOutput = new Map<string, { turnId: string; text: string }>();
  private readonly knownSessions = new Set<string>();
  private readonly closedSessions = new Set<string>();
  /** Provider sessions a handoff replaced. Their closing ends a session, not a conversation. */
  private readonly supersededSessions = new Set<string>();
  private readonly sessionsWithUserTurn = new Set<string>();
  private readonly turns = new Map<string, MemoryExtractionTurn[]>();
  private queue = Promise.resolve();

  public constructor(options: EpisodeMemoryWriterOptions) {
    this.episodes = options.episodes;
    this.subjectId = options.subjectId;
    this.outputTranscriptMode = options.outputTranscriptMode ?? "delta";
    this.preferHeardInput = options.preferHeardInput ?? false;
    this.resolveConversationId = options.resolveConversationId ?? ((sessionId) => sessionId);
    this.extractor = options.extractor;
    this.trace = options.trace ?? (() => {});
  }

  public handle(event: RealtimeSpeechEvent): Promise<void> {
    this.queue = this.queue.then(() => this.process(event));
    return this.queue;
  }

  public handleHeard(input: HeardInput): Promise<void> {
    this.queue = this.queue.then(() => this.processHeard(input));
    return this.queue;
  }

  /**
   * Declares that a handoff replaced this provider session.
   *
   * Its `session.closed` will arrive moments later and must not be read as the conversation
   * ending — that would close the episode and run extraction over half a conversation, which
   * is the failure the conversation id exists to prevent. Any output still in flight is
   * completed as interrupted, because the session carrying it is gone.
   */
  public markSuperseded(physicalSessionId: string): Promise<void> {
    this.supersededSessions.add(physicalSessionId);
    const conversationId = this.resolveConversationId(physicalSessionId);
    this.queue = this.queue.then(async () => {
      const output = this.pendingOutput.get(conversationId);
      if (!output) return;
      const turn = await this.episodes.completeTurn(output.turnId, "interrupted");
      if (turn) this.recordTurn(conversationId, turn.turnId, "assistant", turn.text, turn.status);
      this.pendingOutput.delete(conversationId);
    });
    this.trace({ type: "memory.session.superseded", physicalSessionId, conversationId });
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
    const sessionId = this.resolveConversationId(event.sessionId);
    if (this.closedSessions.has(sessionId)) return;
    if (event.type === "session.started") {
      await this.ensureSession(sessionId);
      return;
    }
    if (event.type === "transcript.final" && event.source === "input") {
      if (this.preferHeardInput) {
        // The voice-to-voice model already understood this audio and records its own
        // verbatim/meaning through record_heard or intelligence_delegate. In this mode the
        // provider's text transcript is not canonical user intent: without a configured
        // language it can turn Czech confirmation into nonsense such as "anomalous".
        // Keep the event in the raw trace and estimator, but do not overwrite heard input.
        this.trace({ type: "memory.transcript.ignored", sessionId, reason: "heard_model_source_enabled" });
        return;
      }
      await this.ensureSession(sessionId);
      const isFirstUserTurn = !this.sessionsWithUserTurn.has(sessionId);
      this.sessionsWithUserTurn.add(sessionId);
      const transcriptConfidence = assessTranscript({ text: event.text, isFirstUserTurn });
      const turn = await this.episodes.appendTurn(sessionId, { speaker: "user", text: event.text, status: "complete", transcriptConfidence });
      if (turn) {
        this.recordTurn(sessionId, turn.turnId, "user", turn.text, turn.status, transcriptConfidence);
        if (transcriptConfidence === "unreliable") this.trace({ type: "memory.transcript.unreliable", sessionId, turnId: turn.turnId, firstUserTurn: isFirstUserTurn, length: event.text.trim().length });
      }
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
      // A replaced session closing is the handoff working, not the conversation ending.
      if (this.supersededSessions.has(event.sessionId)) {
        this.supersededSessions.delete(event.sessionId);
        this.trace({ type: "memory.episode.kept_open", physicalSessionId: event.sessionId, conversationId: sessionId, reason: "superseded_by_handoff" });
        return;
      }
      await this.finish(sessionId, event.type === "session.error" ? "failed" : "completed");
    }
  }

  private async processHeard(input: HeardInput): Promise<void> {
    const verbatim = input.verbatim.trim();
    const meaning = input.meaning.trim();
    const text = verbatim || meaning;
    // The heard record carries the provider session it was captured in; the episode it
    // belongs to is the conversation, which outlives that session across a handoff.
    const sessionId = this.resolveConversationId(input.sessionId);
    if (!text || this.closedSessions.has(sessionId)) return;
    await this.ensureSession(sessionId);
    const transcriptConfidence = assessHeardInput(input);
    const turn = await this.episodes.appendTurn(sessionId, {
      speaker: "user",
      text,
      status: "complete",
      sourceEventId: input.heardId,
      transcriptConfidence,
      ...(verbatim ? { verbatim } : {}),
      ...(meaning ? { meaning } : {}),
      ...(input.uncertainParts.length ? { uncertainParts: input.uncertainParts } : {}),
    });
    if (!turn) return;
    this.sessionsWithUserTurn.add(sessionId);
    this.recordTurn(sessionId, turn.turnId, "user", turn.text, turn.status, transcriptConfidence);
    if (transcriptConfidence === "unreliable") {
      this.trace({ type: "memory.transcript.unreliable", sessionId, turnId: turn.turnId, source: "heard", uncertainParts: input.uncertainParts });
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

  private recordTurn(sessionId: string, turnId: string, speaker: MemoryExtractionTurn["speaker"], text: string, status: MemoryExtractionTurn["status"], transcriptConfidence?: MemoryExtractionTurn["transcriptConfidence"]): void {
    const turns = this.turns.get(sessionId) ?? [];
    const existing = turns.find((turn) => turn.turnId === turnId);
    if (existing) { existing.text = text; existing.status = status; if (transcriptConfidence) existing.transcriptConfidence = transcriptConfidence; } else turns.push({ turnId, speaker, text, status, ...(transcriptConfidence ? { transcriptConfidence } : {}) });
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
