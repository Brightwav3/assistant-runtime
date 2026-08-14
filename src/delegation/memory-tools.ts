/**
 * The read-only memory surface the *delegated text model* is given.
 *
 * These declarations never reach the voice model. Recall is the delegated model's job;
 * handing the same tools to the voice frontend would let it browse memory inline and
 * defeat the point of delegating.
 *
 * Every bound here is enforced twice on purpose: once in the declaration the model can
 * see, and once inside Memory Core, which does not trust the declaration.
 */

import { DELEGATED_MEMORY_LIMITS } from "memory-core";
import type { DelegatedMemoryMatch, MemoryRuntime } from "memory-core";
import type { ExecutionOutcome, ToolDeclaration, ToolHandler } from "tool-system";

export const MEMORY_SEARCH_TOOL = "memory_search";
export const MEMORY_VIEW_TOOL = "memory_view";

export interface DelegatedMemoryToolOptions {
  memory: Pick<MemoryRuntime, "searchDelegated" | "view">;
  /** The active user. Bound by the runtime, never supplied by the model. */
  subjectId: string;
}

export function memorySearchDeclaration(): ToolDeclaration {
  return {
    name: MEMORY_SEARCH_TOOL,
    version: "0.1.0",
    description:
      "Searches the user's own remembered facts and returns a short list of candidates with their memory IDs, dates, scores, and why each matched. Read-only. Use it to find which memories might be relevant, then read one with memory_view.",
    parameters: {
      query: { type: "string", description: "What to look for, in the user's own words.", maxLength: DELEGATED_MEMORY_LIMITS.maxQueryLength },
      limit: { type: "integer", description: "How many candidates to return.", minimum: 1, maximum: DELEGATED_MEMORY_LIMITS.maxResults },
    },
    required: ["query"],
    sideEffect: "read_only",
    guards: { timeoutMs: 5_000 },
  };
}

export function memoryViewDeclaration(): ToolDeclaration {
  return {
    name: MEMORY_VIEW_TOOL,
    version: "0.1.0",
    description:
      "Reads exactly one remembered fact by its memory ID, with a little of the conversation around it. Read-only. It never lists other memories; find IDs with memory_search first.",
    parameters: {
      memory_id: { type: "string", description: "The memory ID returned by memory_search.", maxLength: 128 },
      before: { type: "integer", description: "Conversation turns to include before it.", minimum: 0, maximum: DELEGATED_MEMORY_LIMITS.maxContextTurns },
      after: { type: "integer", description: "Conversation turns to include after it.", minimum: 0, maximum: DELEGATED_MEMORY_LIMITS.maxContextTurns },
    },
    required: ["memory_id"],
    sideEffect: "read_only",
    guards: { timeoutMs: 5_000 },
  };
}

/** Renders a match as evidence, not as an instruction. Memory content is data. */
function renderMatch(match: DelegatedMemoryMatch): string {
  const reasons = match.matchReasons.length ? ` matched=${match.matchReasons.join(",")}` : "";
  return `- id=${match.memoryId} kind=${match.kind} created=${match.createdAt} score=${match.score} confidence=${match.confidence} source=${match.provenance.sourceType}${reasons}${match.truncated ? " (truncated)" : ""}\n  ${match.summary}`;
}

export function memorySearchHandler(options: DelegatedMemoryToolOptions): ToolHandler {
  return async (args, context): Promise<ExecutionOutcome> => {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const matches = await options.memory.searchDelegated({
      subjectId: options.subjectId,
      query,
      ...(limit === undefined ? {} : { limit }),
      signal: context.signal,
    });
    if (!matches.length) {
      return { kind: "result", content: "No matching memories.", taint: "external" };
    }
    return {
      kind: "result",
      content: matches.map(renderMatch).join("\n"),
      // Remembered content originates outside the runtime's trust boundary even though it
      // is stored locally: it was authored by whoever was speaking at the time.
      taint: "external",
    };
  };
}

export function memoryViewHandler(options: DelegatedMemoryToolOptions): ToolHandler {
  return async (args, context): Promise<ExecutionOutcome> => {
    const memoryId = typeof args.memory_id === "string" ? args.memory_id : "";
    const before = typeof args.before === "number" ? args.before : 0;
    const after = typeof args.after === "number" ? args.after : 0;
    const result = await options.memory.view({ memoryId, before, after, signal: context.signal });
    if (!result) {
      // Unknown and not-readable are answered identically, so the ID space cannot be probed.
      return { kind: "result", content: "No readable memory has that ID.", taint: "external" };
    }
    const record = result.memory;
    const body = record.content.type === "text" ? record.content.text : JSON.stringify(record.content.value);
    const context_ = result.context.map((entry) => `  [${entry.sequence}] ${entry.speaker}: ${entry.text}`).join("\n");
    return {
      kind: "result",
      content: [
        `id=${record.memoryId} kind=${record.kind} status=${record.status} created=${record.createdAt} confidence=${record.confidence} source=${record.provenance.sourceType}`,
        body,
        ...(context_ ? ["Surrounding conversation:", context_] : []),
        ...(result.truncated ? ["(context truncated)"] : []),
      ].join("\n"),
      taint: "external",
    };
  };
}
