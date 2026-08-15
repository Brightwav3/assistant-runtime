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

type CandidateValidation = { candidate?: MemoryCandidate; reason?: string };

function normalizeContent(value: unknown): MemoryContent | undefined {
  if (typeof value === "string" && value.trim()) return { type: "text", text: value.trim() };
  return isContent(value) ? value : undefined;
}

function normalizeEvidence(value: unknown, input: MemoryExtractionInput): MemoryCandidate["evidence"] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const turnIds = new Set(input.turns.map(({ turnId }) => turnId));
  const normalized: MemoryCandidate["evidence"] = [];
  for (const item of value) {
    if (typeof item === "string" && turnIds.has(item)) {
      normalized.push({ sourceType: "turn", sourceId: item });
      continue;
    }
    if (!isRecord(item)) return undefined;
    const shorthandTurnId = typeof item.turnId === "string" ? item.turnId : undefined;
    if (shorthandTurnId && turnIds.has(shorthandTurnId)) {
      normalized.push({ sourceType: "turn", sourceId: shorthandTurnId });
      continue;
    }
    const sourceId = typeof item.sourceId === "string" ? item.sourceId : undefined;
    if (!sourceId) return undefined;
    if ((item.sourceType === "turn" || item.sourceType === "conversation") && turnIds.has(sourceId)) {
      normalized.push({ sourceType: "turn", sourceId });
      continue;
    }
    if (item.sourceType === "session" && sourceId === input.sessionId) {
      normalized.push({ sourceType: "session", sourceId });
      continue;
    }
    if (item.sourceType === "user" && sourceId === input.subjectId) {
      normalized.push({ sourceType: "user", sourceId });
      continue;
    }
    return undefined;
  }
  return normalized;
}

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
        { role: "system", content: `Extract only durable memory candidates from the episode. Return JSON only: an array of objects in this exact shape: {"candidateId":"id","disposition":"store|confirm|episode_only|discard","kind":"fact|preference|person|project|decision|event|summary|instructional","subjectId":"${input.subjectId}","content":{"type":"text","text":"durable fact"},"confidence":0.95,"evidence":[{"sourceType":"turn","sourceId":"an exact turnId from the input"}],"reason":"why it is durable"}. The model proposes candidates; it is not the authority to persist them. Use episode_only or discard for transient information.` },
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
      const validation = this.validateCandidate(value, input);
      if (!validation.candidate) {
        rejected += 1;
        this.trace({ type: "memory.candidate.invalid", index, candidateId: isRecord(value) && typeof value.candidateId === "string" ? value.candidateId : null, reason: validation.reason ?? "candidate failed schema validation" });
        continue;
      }
      candidates.push(this.applyPolicy(validation.candidate));
    }
    if (rejected > 0) this.trace({ type: "memory.extraction.partial", accepted: candidates.length, rejected });
    return candidates;
  }

  private validateCandidate(value: unknown, input: MemoryExtractionInput): CandidateValidation {
    if (!isRecord(value)) return { reason: "candidate must be an object" };
    if (typeof value.candidateId !== "string" || !value.candidateId.trim()) return { reason: "candidateId is missing" };
    if (!dispositions.has(value.disposition as MemoryCandidateDisposition)) return { reason: "disposition is invalid" };
    if (!memoryKinds.includes(value.kind as MemoryKind)) return { reason: "kind is invalid" };
    if (value.subjectId !== undefined && value.subjectId !== input.subjectId) return { reason: "subjectId does not match the runtime-bound subject" };
    const content = normalizeContent(value.content);
    if (!content) return { reason: "content is invalid" };
    if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) return { reason: "confidence is invalid" };
    if (typeof value.reason !== "string" || !value.reason.trim()) return { reason: "reason is missing" };
    const evidence = normalizeEvidence(value.evidence, input);
    if (!evidence) return { reason: "evidence does not reference this episode" };
    return { candidate: { candidateId: value.candidateId, disposition: value.disposition as MemoryCandidateDisposition, kind: value.kind as MemoryKind, subjectId: input.subjectId, ...(typeof value.key === "string" && value.key.trim() ? { key: value.key } : {}), content, confidence: value.confidence, evidence, reason: value.reason } };
  }

  private applyPolicy(candidate: MemoryCandidate): MemoryCandidate {
    if (candidate.disposition !== "store" || (this.autoStoreKinds.has(candidate.kind) && candidate.confidence >= this.minimumAutoStoreConfidence)) return candidate;
    return { ...candidate, disposition: "confirm", reason: `${candidate.reason} Automatic storage policy requires explicit confirmation for this candidate.` };
  }

  private invalidOutput(reason: string): MemoryCandidate[] { this.trace({ type: "memory.extraction.invalid_output", reason }); return []; }
}
