import type { MemoryCandidate, MemoryCandidateDisposition, MemoryContent, MemoryExtractionInput, MemoryExtractor, MemoryKind } from "intelligence-core";
import { memoryKinds, type ModelExecutor, type ModelResponse } from "intelligence-core";

export interface GeminiMemoryExtractorOptions {
  models: ModelExecutor;
  providerId: string;
  model: string;
  minimumAutoStoreConfidence?: number;
  autoStoreKinds?: MemoryKind[];
  trace?: (event: Record<string, unknown>) => void;
}

const dispositions = new Set<MemoryCandidateDisposition>(["store", "confirm", "episode_only", "discard"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isContent = (value: unknown): value is MemoryContent => isRecord(value) && ((value.type === "text" && typeof value.text === "string" && value.text.trim() !== "") || (value.type === "structured" && isRecord(value.value)));
const parseJson = (text: string): unknown => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
};

export class GeminiMemoryExtractor implements MemoryExtractor {
  private readonly minimumAutoStoreConfidence: number;
  private readonly autoStoreKinds: Set<MemoryKind>;
  private readonly trace: (event: Record<string, unknown>) => void;

  public constructor(private readonly options: GeminiMemoryExtractorOptions) {
    this.minimumAutoStoreConfidence = options.minimumAutoStoreConfidence ?? 0.9;
    this.autoStoreKinds = new Set(options.autoStoreKinds ?? ["preference", "instructional"]);
    this.trace = options.trace ?? (() => {});
  }

  public async extract(input: MemoryExtractionInput, signal?: AbortSignal): Promise<MemoryCandidate[]> {
    if (signal?.aborted) throw new Error("Memory extraction cancelled");
    const response = await this.options.models.generate({
      provider_id: this.options.providerId,
      model: this.options.model,
      messages: [
        { role: "system", content: "Extract only durable memory candidates from the episode. Return JSON only: an array of objects with candidateId, disposition, kind, subjectId, optional key, content, confidence, evidence, and reason. The model proposes candidates; it is not the authority to persist them. Use episode_only or discard for transient information." },
        { role: "user", content: JSON.stringify(input) },
      ],
    }, signal);
    if (signal?.aborted) throw new Error("Memory extraction cancelled");
    if (response.type !== "final") return this.invalidOutput("model did not return a final JSON response");
    let parsed: unknown;
    try { parsed = parseJson(response.message.content); } catch { return this.invalidOutput("model returned malformed JSON"); }
    if (!Array.isArray(parsed)) return this.invalidOutput("model JSON must be an array");
    // This model has no structured-output support, so malformed candidates are expected
    // rather than exceptional. A bad proposal is skipped and reported; it must not cost
    // the valid proposals that arrived in the same response.
    const candidates: MemoryCandidate[] = [];
    let rejected = 0;
    for (const [index, value] of parsed.entries()) {
      const candidate = this.validateCandidate(value, input.subjectId);
      if (!candidate) {
        rejected += 1;
        this.trace({ type: "memory.candidate.invalid", index, candidateId: isRecord(value) && typeof value.candidateId === "string" ? value.candidateId : null, reason: "candidate failed schema validation" });
        continue;
      }
      candidates.push(this.applyPolicy(candidate));
    }
    if (rejected > 0) this.trace({ type: "memory.extraction.partial", accepted: candidates.length, rejected });
    return candidates;
  }

  private validateCandidate(value: unknown, subjectId: string): MemoryCandidate | undefined {
    if (!isRecord(value) || typeof value.candidateId !== "string" || !dispositions.has(value.disposition as MemoryCandidateDisposition) || !memoryKinds.includes(value.kind as MemoryKind) || value.subjectId !== subjectId || !isContent(value.content) || typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1 || typeof value.reason !== "string" || value.reason.trim() === "" || !Array.isArray(value.evidence) || value.evidence.length === 0) return undefined;
    const evidence = value.evidence.filter((item): item is { sourceType: "turn" | "session" | "user"; sourceId: string } => isRecord(item) && (item.sourceType === "turn" || item.sourceType === "session" || item.sourceType === "user") && typeof item.sourceId === "string" && item.sourceId.trim() !== "");
    if (evidence.length !== value.evidence.length) return undefined;
    return { candidateId: value.candidateId, disposition: value.disposition as MemoryCandidateDisposition, kind: value.kind as MemoryKind, subjectId, ...(typeof value.key === "string" && value.key.trim() ? { key: value.key } : {}), content: value.content, confidence: value.confidence, evidence, reason: value.reason };
  }

  private applyPolicy(candidate: MemoryCandidate): MemoryCandidate {
    if (candidate.disposition !== "store" || (this.autoStoreKinds.has(candidate.kind) && candidate.confidence >= this.minimumAutoStoreConfidence)) return candidate;
    return { ...candidate, disposition: "confirm", reason: `${candidate.reason} Automatic storage policy requires explicit confirmation for this candidate.` };
  }

  private invalidOutput(reason: string): MemoryCandidate[] { this.trace({ type: "memory.extraction.invalid_output", reason }); return []; }
}
