import type { CreateMemoryInput, MemoryRuntime } from "memory-core";
import type { RealtimeSpeechEvent } from "realtime-core";

interface PendingTurn {
  input: string[];
  output: string[];
}

/** Persists compact conversation turns while deliberately ignoring raw audio. */
export class ConversationMemoryWriter {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly sequences = new Map<string, number>();
  private queue = Promise.resolve();

  constructor(private readonly memory: MemoryRuntime, private readonly subjectId: string, private readonly trace: (event: Record<string, unknown>) => void = () => {}) {}

  handle(event: RealtimeSpeechEvent): Promise<void> {
    this.queue = this.queue.then(() => this.process(event));
    return this.queue;
  }

  async flush(): Promise<void> {
    await this.queue;
    for (const sessionId of [...this.pending.keys()]) await this.persist(sessionId);
  }

  private async process(event: RealtimeSpeechEvent): Promise<void> {
    const turn = this.pending.get(event.sessionId) ?? { input: [], output: [] };
    if (event.type === "transcript.final" && event.source === "input") turn.input.push(event.text);
    if (event.type === "transcript.partial" && event.source === "output" && turn.input.length > 0) turn.output.push(event.text);
    this.pending.set(event.sessionId, turn);

    if (event.type === "output.audio_completed" || event.type === "session.closed" || event.type === "session.error") {
      await this.persist(event.sessionId);
      if (turn.input.length === 0) this.pending.delete(event.sessionId);
    }
  }

  private async persist(sessionId: string): Promise<void> {
    const turn = this.pending.get(sessionId);
    if (!turn || turn.input.length === 0) return;
    const content = [
      `Uživatel: ${turn.input.join(" ")}`,
      ...(turn.output.length > 0 ? [`Jarvis: ${turn.output.join(" ")}`] : []),
    ].join("\n");
    const sequence = this.sequences.get(sessionId) ?? 0;
    this.sequences.set(sessionId, sequence + 1);
    const sourceId = `${sessionId}:${sequence}`;
    const input: CreateMemoryInput = {
      kind: "summary",
      content: { type: "text", text: content },
      scope: { type: "user", subjectId: this.subjectId },
      provenance: { sourceType: "conversation", sourceId },
      confidence: 0.9,
      tags: ["automatic", "conversation"],
      metadata: { sessionId },
    };
    try {
      await this.memory.create(input);
      this.trace({ type: "memory.conversation.saved", sessionId, sourceId });
      turn.input = [];
      turn.output = [];
    } catch (error) {
      this.trace({ type: "memory.conversation.save_failed", sessionId, message: error instanceof Error ? error.message : String(error) });
    }
    if (turn.input.length === 0 && turn.output.length === 0) this.pending.delete(sessionId);
  }
}
