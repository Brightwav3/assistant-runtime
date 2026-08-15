import { MemoryError, memoryKinds, type EpisodeRuntime, type MemoryKind, type MemoryRuntime } from "memory-core";
import type { ExecutionOutcome, ToolDeclaration, ToolHandler } from "tool-system";

export const MEMORY_CREATE_TOOL = "memory_create";

export interface MemoryCreateOptions {
  memory: MemoryRuntime;
  episodes: Pick<EpisodeRuntime, "listTurns">;
  subjectId: string;
  session: () => string | undefined;
  trace?: (event: Record<string, unknown>) => void;
}

const explicitTrigger = /\b(zapamatuj(?:te)?(?:\s+si)?|měj(?:te)?\s+na\s+paměti|nezapomeň(?:te)?)\b/iu;
const normalize = (value: string): string => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

export function memoryCreateDeclaration(): ToolDeclaration {
  return {
    name: MEMORY_CREATE_TOOL,
    version: "0.1.0",
    description: "Immediately stores a durable fact only when the current user turn explicitly says zapamatuj si, měj na paměti, or nezapomeň. Use the runtime-bound turnId shown in Current conversation evidence.",
    parameters: {
      turn_id: { type: "string", description: "Exact current user turnId from runtime-bound conversation evidence.", maxLength: 100 },
      kind: { type: "string", description: "Memory kind.", enum: [...memoryKinds] },
      content: { type: "string", description: "Concise durable fact supported by that user turn.", maxLength: 500 },
    },
    required: ["turn_id", "kind", "content"],
    sideEffect: "local_state",
    guards: { timeoutMs: 5_000, cooldownMs: 500 },
  };
}

export function memoryCreateHandler(options: MemoryCreateOptions): ToolHandler {
  return async (args): Promise<ExecutionOutcome> => {
    const sessionId = options.session();
    const turnId = typeof args.turn_id === "string" ? args.turn_id.trim() : "";
    const content = typeof args.content === "string" ? args.content.trim() : "";
    const kind = typeof args.kind === "string" && memoryKinds.includes(args.kind as MemoryKind) ? args.kind as MemoryKind : undefined;
    const reject = (code: string, message: string): ExecutionOutcome => {
      options.trace?.({ type: "memory.explicit.rejected", code, turnId: turnId || undefined });
      return { kind: "error", error: { code: "invalid_arguments", message: `${code}: ${message}`, retryable: false } };
    };
    if (!sessionId || !turnId || !content || !kind) return reject("MEMORY_EXPLICIT_INVALID", "A bound turn, valid kind, and content are required.");
    const turns = await options.episodes.listTurns(sessionId);
    const turn = turns.find((entry) => entry.turnId === turnId);
    const latestUser = [...turns].reverse().find((entry) => entry.speaker === "user");
    if (!turn || turn.speaker !== "user" || latestUser?.turnId !== turnId) return reject("MEMORY_EXPLICIT_STALE_TURN", "The evidence is not the current user turn.");
    const uncertain = turn.uncertainParts ?? [];
    if (turn.transcriptConfidence === "unreliable" && uncertain.length === 0) return reject("MEMORY_EXPLICIT_UNRELIABLE", "The current transcript is unreliable without usable span confidence.");
    const evidence = [turn.verbatim, turn.meaning, turn.text].filter(Boolean).join(" ");
    if (!explicitTrigger.test(evidence)) return reject("MEMORY_EXPLICIT_TRIGGER_REQUIRED", "The user did not explicitly ask to remember this.");
    if (uncertain.some((part) => explicitTrigger.test(part.text))) return reject("MEMORY_EXPLICIT_TRIGGER_UNCERTAIN", "The explicit remember instruction itself is uncertain.");
    const normalizedContent = normalize(content);
    const usedUncertainParts = uncertain.filter((part) => normalizedContent.includes(normalize(part.text)));
    const confidence = usedUncertainParts.reduce((minimum, part) => Math.min(minimum, part.confidence), 1);

    const existing = (await options.memory.list({ kinds: [kind], scopes: [{ type: "user", subjectId: options.subjectId }], statuses: ["active"] }))
      .find((record) => record.content.type === "text" && normalize(record.content.text) === normalize(content));
    if (existing) {
      options.trace?.({ type: "memory.explicit.duplicate", memoryId: existing.memoryId, turnId });
      return { kind: "result", content: JSON.stringify({ operation: MEMORY_CREATE_TOOL, status: "already_exists", memoryId: existing.memoryId }), taint: "trusted" };
    }
    try {
      const record = await options.memory.create({
        kind,
        content: { type: "text", text: content },
        scope: { type: "user", subjectId: options.subjectId },
        provenance: { sourceType: "conversation", sourceId: turnId },
        confidence,
        metadata: { explicit: true, sessionId, ...(uncertain.length ? { uncertainEvidence: uncertain } : {}), ...(usedUncertainParts.length ? { usedUncertainEvidence: usedUncertainParts } : {}) },
      });
      options.trace?.({ type: "memory.explicit.created", memoryId: record.memoryId, turnId });
      return { kind: "result", content: JSON.stringify({ operation: MEMORY_CREATE_TOOL, status: "created", memoryId: record.memoryId }), taint: "trusted" };
    } catch (error) {
      if (error instanceof MemoryError && error.code === "MEMORY_CONFLICT") {
        const duplicate = (await options.memory.list({ scopes: [{ type: "user", subjectId: options.subjectId }], statuses: ["active"] }))
          .find((record) => record.content.type === "text" && normalize(record.content.text) === normalize(content));
        if (duplicate) return { kind: "result", content: JSON.stringify({ operation: MEMORY_CREATE_TOOL, status: "already_exists", memoryId: duplicate.memoryId }), taint: "trusted" };
      }
      return reject("MEMORY_EXPLICIT_STORE_FAILED", "The memory could not be stored.");
    }
  };
}
