import { MemoryRuntime } from "memory-core";
import type { MemoryCandidate, MemoryExtractionInput, MemoryExtractor } from "intelligence-core";

export interface MemoryExtractionResult { stored: string[]; confirmed: string[]; episodeOnly: string[]; discarded: string[]; }

/** Applies provider proposals through Memory Core; extractors never write to SQLite directly. */
export class MemoryExtractionOrchestrator {
  public constructor(private readonly memory: MemoryRuntime, private readonly extractor: MemoryExtractor, private readonly trace: (event: Record<string, unknown>) => void = () => {}) {}

  public async process(input: MemoryExtractionInput, signal?: AbortSignal): Promise<MemoryExtractionResult> {
    const result: MemoryExtractionResult = { stored: [], confirmed: [], episodeOnly: [], discarded: [] };
    const candidates = await this.extractor.extract(input, signal);
    for (const candidate of candidates) await this.applyCandidate(candidate, input, result);
    return result;
  }

  private async applyCandidate(candidate: MemoryCandidate, input: MemoryExtractionInput, result: MemoryExtractionResult): Promise<void> {
    if (candidate.subjectId !== input.subjectId || !candidate.reason.trim() || candidate.evidence.length === 0) {
      this.trace({ type: "memory.candidate.rejected", candidateId: candidate.candidateId, reason: "candidate validation failed" });
      result.discarded.push(candidate.candidateId);
      return;
    }
    if (candidate.disposition === "store") {
      try {
        await this.memory.create({ kind: candidate.kind, content: candidate.content, scope: { type: "user", subjectId: candidate.subjectId }, provenance: { sourceType: "conversation", sourceId: input.sessionId ?? candidate.evidence[0]!.sourceId }, confidence: candidate.confidence, metadata: { candidateId: candidate.candidateId, reason: candidate.reason, evidence: candidate.evidence, ...(candidate.key ? { key: candidate.key } : {}) } });
        result.stored.push(candidate.candidateId);
        this.trace({ type: "memory.candidate.stored", candidateId: candidate.candidateId });
      } catch (error) { this.trace({ type: "memory.candidate.store_failed", candidateId: candidate.candidateId, message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (candidate.disposition === "confirm") { result.confirmed.push(candidate.candidateId); this.trace({ type: "memory.candidate.confirm", candidateId: candidate.candidateId, reason: candidate.reason }); return; }
    if (candidate.disposition === "episode_only") { result.episodeOnly.push(candidate.candidateId); this.trace({ type: "memory.candidate.episode_only", candidateId: candidate.candidateId }); return; }
    result.discarded.push(candidate.candidateId);
    this.trace({ type: "memory.candidate.discard", candidateId: candidate.candidateId, reason: candidate.reason });
  }
}
