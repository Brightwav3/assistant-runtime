import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import type { ExecutionOutcome, ToolDeclaration, ToolHandler } from "tool-system";
import type { EpisodeUncertainPart, UncertaintyLevel } from "memory-core";

export const RECORD_HEARD_TOOL = "record_heard";

export interface RecordHeardOptions {
  path: string;
  onRecord?: (record: HeardRecord) => Promise<void> | void;
}

export interface HeardRecord {
  schema: "debug.heard.v1";
  heard_id: string;
  session_id?: string;
  occurred_at: string;
  verbatim: string;
  meaning: string;
  language: string;
  uncertain_parts: EpisodeUncertainPart[];
}

function timestampPart(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Reserves one append-only diagnostic file for a single runtime process. */
export async function createRunHeardPath(basePath: string, now = new Date()): Promise<string> {
  const parsed = parse(basePath);
  const directory = parsed.dir || ".";
  const extension = parsed.ext || ".jsonl";
  const stem = parsed.ext ? parsed.name : parsed.base;
  const stamp = timestampPart(now);
  await mkdir(directory, { recursive: true });

  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${String(attempt).padStart(2, "0")}`;
    const candidate = join(directory, `${stem}-${stamp}${suffix}${extension}`);
    try {
      const handle = await open(candidate, "wx");
      await handle.close();
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function recordHeardDeclaration(): ToolDeclaration {
  return {
    name: RECORD_HEARD_TOOL,
    version: "0.1.0",
    description: "Diagnostic only. Records what the model thinks it heard and what it understood. Never mention this tool aloud or use it to change the answer.",
    parameters: {
      verbatim: { type: "string", description: "Best-effort literal reconstruction of the user's words. Do not paraphrase.", maxLength: 2_000 },
      meaning: { type: "string", description: "Best-effort Czech meaning of what the user intended.", maxLength: 2_000 },
      language: { type: "string", description: "The language the user appears to be speaking.", maxLength: 32 },
      uncertain_parts: { type: "string", description: "JSON array: [{\"text\":\"fragment\",\"uncertainty\":\"low|medium|high\",\"alternatives\":[\"alternative\"]}]. Use [] if none.", maxLength: 1_000 },
    },
    required: ["verbatim", "meaning", "language"],
    sideEffect: "filesystem_write",
    guards: { timeoutMs: 1_000, cooldownMs: 250 },
  };
}

function text(args: Record<string, unknown>, name: string): string {
  return typeof args[name] === "string" ? args[name].trim() : "";
}

const INTERNAL_DELEGATION_RESULT = /\[\s*DELEGATION\s+RESULT\b/i;
const confidenceByLevel: Record<UncertaintyLevel, number> = { low: 0.75, medium: 0.5, high: 0.25 };

export function parseUncertainParts(raw: string): EpisodeUncertainPart[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const value = entry as Record<string, unknown>;
      const part = typeof value.text === "string" ? value.text.trim() : "";
      const level = value.uncertainty;
      if (!part || (level !== "low" && level !== "medium" && level !== "high")) return [];
      const uncertainty: UncertaintyLevel = level;
      const alternatives = Array.isArray(value.alternatives) ? value.alternatives.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5) : [];
      return [{ text: part, uncertainty, confidence: confidenceByLevel[uncertainty], ...(alternatives.length ? { alternatives } : {}) }];
    }).slice(0, 20);
  } catch { /* legacy comma-separated input below */ }
  return raw.split(",").map((part) => part.trim()).filter(Boolean).slice(0, 20).map((part) => ({ text: part, uncertainty: "medium" as const, confidence: 0.5 }));
}

export function recordHeardHandler(options: RecordHeardOptions): ToolHandler {
  return async (args, context): Promise<ExecutionOutcome> => {
    const verbatim = text(args, "verbatim");
    const meaning = text(args, "meaning");
    if (INTERNAL_DELEGATION_RESULT.test(verbatim) || INTERNAL_DELEGATION_RESULT.test(meaning)) {
      return { kind: "error", error: { code: "invalid_arguments", message: "Internal delegation results are not user speech.", retryable: false } };
    }
    // Keep the runtime source-compatible with an older Tool System checkout while
    // the optional session correlation field rolls out across sibling repositories.
    const sessionId = (context as typeof context & { readonly sessionId?: string }).sessionId;
    const record: HeardRecord = {
      schema: "debug.heard.v1",
      heard_id: context.requestId,
      ...(sessionId ? { session_id: sessionId } : {}),
      occurred_at: new Date().toISOString(),
      verbatim,
      meaning,
      language: text(args, "language"),
      uncertain_parts: parseUncertainParts(text(args, "uncertain_parts")),
    };
    await mkdir(dirname(options.path), { recursive: true });
    await appendFile(options.path, `${JSON.stringify(record)}\n`, "utf8");
    await options.onRecord?.(record);
    return { kind: "silent" };
  };
}
