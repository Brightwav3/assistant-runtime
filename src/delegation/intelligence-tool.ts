/**
 * `intelligence_delegate` — the only tool the voice model is given by default.
 *
 * It returns a continuation immediately and never awaits the answer. That is the whole
 * mechanism: the voice model gets something true to say now, the delegated model does
 * the real work, and the result comes back later through the delivery scheduler as an
 * explicitly labelled delegation result.
 *
 * The delegated model must not receive this declaration, or it could delegate to itself.
 */

import type { ExecutionOutcome, ToolDeclaration, ToolHandler } from "tool-system";
import type { DelegationBroker, DelegationDeliveryPolicy, DelegationModelSelection } from "../contracts.js";

export const INTELLIGENCE_DELEGATE_TOOL = "intelligence_delegate";

export const DELEGATE_LIMITS = Object.freeze({ maxGoalLength: 1_000, maxMemoryIds: 8 } as const);

export interface IntelligenceDelegateOptions {
  broker: DelegationBroker;
  model: DelegationModelSelection;
  /** Supplies the live conversation identity. Bound by the runtime; the model cannot name another session. */
  correlation: () => { sessionId?: string; interactionId?: string };
  deadlineMs?: number;
  maximumModelCalls: number;
  maximumToolCalls: number;
  cancelOnSessionClose: boolean;
  defaultDelivery: DelegationDeliveryPolicy;
  clock?: () => number;
}

export function intelligenceDelegateDeclaration(): ToolDeclaration {
  return {
    name: INTELLIGENCE_DELEGATE_TOOL,
    version: "0.1.0",
    description:
      "Hands a question that needs real lookup or reasoning to the assistant's background intelligence. Returns immediately: acknowledge briefly, keep talking with the user, and wait for the result to arrive. Never state the answer before it arrives.",
    parameters: {
      goal: { type: "string", description: "What the background intelligence should find out, stated plainly.", maxLength: DELEGATE_LIMITS.maxGoalLength },
      memory_ids: { type: "string", description: "Optional comma-separated memory IDs the user has already referred to.", maxLength: 1_200 },
      delivery: { type: "string", description: "How the answer should come back.", enum: ["interrupt", "when_idle", "silent"] },
    },
    required: ["goal"],
    // Delegating creates a tracked background execution, which is runtime state rather
    // than a pure read, even though nothing outside the process is written.
    sideEffect: "local_state",
    guards: { timeoutMs: 5_000 },
  };
}

function parseMemoryIds(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, DELEGATE_LIMITS.maxMemoryIds);
}

export function intelligenceDelegateHandler(options: IntelligenceDelegateOptions): ToolHandler {
  const clock = options.clock ?? (() => Date.now());
  return async (args): Promise<ExecutionOutcome> => {
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (!goal) {
      return { kind: "error", error: { code: "invalid_arguments", message: "A goal is required to delegate.", retryable: false } };
    }
    if (goal.length > DELEGATE_LIMITS.maxGoalLength) {
      return { kind: "error", error: { code: "invalid_arguments", message: `The goal must be ${DELEGATE_LIMITS.maxGoalLength} characters or fewer.`, retryable: false } };
    }
    const delivery = typeof args.delivery === "string" && ["interrupt", "when_idle", "silent"].includes(args.delivery)
      ? (args.delivery as DelegationDeliveryPolicy["mode"])
      : options.defaultDelivery.mode;

    const correlation = options.correlation();
    const accepted = await options.broker.accept({
      requestId: `req_${clock()}_${Math.abs(hash(goal))}`,
      ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
      ...(correlation.interactionId ? { interactionId: correlation.interactionId } : {}),
      goal,
      selectedMemoryIds: parseMemoryIds(args.memory_ids),
      selectedContext: [],
      model: options.model,
      ...(options.deadlineMs ? { deadlineAt: new Date(clock() + options.deadlineMs).toISOString() } : {}),
      cancelOnSessionClose: options.cancelOnSessionClose,
      maximumModelCalls: options.maximumModelCalls,
      maximumToolCalls: options.maximumToolCalls,
      delivery: { ...options.defaultDelivery, mode: delivery },
    });

    return {
      kind: "continuation",
      continuationId: accepted.executionId,
      // The structured instruction is serialized rather than prose-ified: the voice model
      // chooses its own words, and no sentence is hardcoded in the runtime.
      acknowledgement: JSON.stringify(accepted.assistantInstruction),
    };
  };
}

/** Deterministic, non-cryptographic — only used to keep request ids distinct within a millisecond. */
function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = (Math.imul(31, result) + value.charCodeAt(index)) | 0;
  return result;
}
