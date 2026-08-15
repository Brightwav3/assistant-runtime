/**
 * The runtime-owned Delegation Broker.
 *
 * It exists so that "I'll look into that" can be true the moment it is said. The
 * broker mints an execution identity, hands it back, and only then lets Intelligence
 * Core start work — so the voice model has something real to acknowledge and correlate
 * against, and never has to invent a result to fill the gap.
 *
 * Authority stays here: the voice model requests, the broker decides. Model selection,
 * limits, deadlines, cancellation and delivery policy are all the runtime's, not the
 * requester's.
 */

import { randomUUID } from "node:crypto";
import type { AcceptedExecution, IntelligenceRequest } from "intelligence-core";
import type {
  DelegationAccepted,
  DelegationBroker,
  DelegationEvent,
  DelegationFailure,
  DelegationRequest,
  DelegationStructuredResult,
} from "../contracts.js";

/** The slice of IntelligenceRuntime the broker needs. Narrow on purpose: it is not the gateway's owner. */
export interface DelegationIntelligence {
  accept(request: IntelligenceRequest): AcceptedExecution;
}

export interface DelegationBrokerOptions {
  intelligence: DelegationIntelligence;
  /** Instruction text handed to the voice model. Configurable and localizable; it is never spoken verbatim by the runtime. */
  acknowledgementText?: string;
  clock?: () => string;
  idFactory?: () => string;
}

const DEFAULT_ACKNOWLEDGEMENT =
  "Background work has started. Acknowledge briefly and naturally that you are looking into it, then continue the conversation. Do not state or invent a result; it will arrive separately as a delegation result.";

interface TrackedDelegation {
  request: DelegationRequest;
  handle: AcceptedExecution;
  terminal: boolean;
}

/**
 * Reads a delegation result out of whatever the model actually produced.
 *
 * A text model returns text, even when it is returning JSON — and it commonly wraps that
 * JSON in a markdown fence. Requiring a `structured` output meant every real delegation
 * failed while the scripted test passed, so text is parsed here too. What is *not*
 * relaxed is validation: prose that is not a delegation result is still refused, because
 * the voice model must never be handed something unvalidated to narrate.
 */
export function readDelegationOutput(output: { type: "text"; text: string } | { type: "structured"; value: Record<string, unknown> }): DelegationStructuredResult | undefined {
  if (output.type === "structured") return parseDelegationResult(output.value);
  const text = output.text.trim();
  // ```json … ``` or ``` … ```
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced?.[1] ?? text;
  // A model sometimes adds a sentence around the object; take the outermost braces.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return parseDelegationResult(JSON.parse(candidate.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

/** Validates the terminal output actually is a delegation result rather than prose that looks like one. */
export function parseDelegationResult(value: unknown): DelegationStructuredResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== "delegation.result.v1") return undefined;
  if (typeof candidate.data !== "object" || candidate.data === null || Array.isArray(candidate.data)) return undefined;
  if (!Array.isArray(candidate.references)) return undefined;
  const references = candidate.references.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
  if (references.length !== candidate.references.length) return undefined;
  if (!references.every((entry) => {
    if (typeof entry.provenance !== "object" || entry.provenance === null) return false;
    const provenance = entry.provenance as Record<string, unknown>;
    if (typeof entry.memoryId === "string" && entry.memoryId.trim()) return true;
    return typeof entry.turnId === "string" && entry.turnId.trim().length > 0
      && provenance.sourceType === "conversation"
      && provenance.sourceId === entry.turnId;
  })) return undefined;
  return {
    schema: "delegation.result.v1",
    ...(typeof candidate.summary === "string" ? { summary: candidate.summary } : {}),
    data: candidate.data as Record<string, unknown>,
    references: references as unknown as DelegationStructuredResult["references"],
  };
}

export class RuntimeDelegationBroker implements DelegationBroker {
  private readonly listeners = new Set<(event: DelegationEvent) => void>();
  private readonly tracked = new Map<string, TrackedDelegation>();
  private readonly clock: () => string;
  private readonly idFactory: () => string;

  public constructor(private readonly options: DelegationBrokerOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => `del_${randomUUID()}`);
  }

  public onEvent(listener: (event: DelegationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: DelegationEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  public async accept(input: Omit<DelegationRequest, "executionId">): Promise<DelegationAccepted> {
    const executionId = this.idFactory();
    // Selected context is copied, not referenced: the delegated model must not observe
    // later edits to a caller's array mid-flight.
    const request: DelegationRequest = {
      ...input,
      executionId,
      selectedMemoryIds: [...input.selectedMemoryIds],
      selectedContext: input.selectedContext.map((entry) => ({ ...entry })),
      model: { ...input.model, fallbackModels: [...input.model.fallbackModels] },
    };

    const base = { requestId: request.requestId, executionId, ...(request.sessionId ? { sessionId: request.sessionId } : {}), ...(request.interactionId ? { interactionId: request.interactionId } : {}) };
    this.emit({ type: "delegation.created", ...base, occurredAt: this.clock() });

    const handle = this.options.intelligence.accept(this.toIntelligenceRequest(request));
    this.tracked.set(executionId, { request, handle, terminal: false });
    this.emit({ type: "delegation.accepted", ...base, occurredAt: this.clock() });
    this.emit({ type: "delegation.started", ...base, occurredAt: this.clock() });

    // Observed without blocking the caller: the acknowledgement must not wait on the model.
    void this.observe(executionId);

    return {
      requestId: request.requestId,
      executionId,
      status: "accepted",
      assistantInstruction: {
        type: "acknowledge-background-work",
        text: this.options.acknowledgementText ?? DEFAULT_ACKNOWLEDGEMENT,
        doNotInventResult: true,
      },
    };
  }

  private toIntelligenceRequest(request: DelegationRequest): IntelligenceRequest {
    const context = request.selectedContext.map((entry) => `[${entry.kind}:${entry.sourceId}] ${entry.text}`).join("\n");
    return {
      request_id: request.requestId,
      input: { type: "text", text: context ? `${request.goal}\n\nSelected context:\n${context}` : request.goal },
      // The selection travels with the execution rather than being read off the action
      // runtime's constructor. Without this the configured fallback models were carried
      // the whole way here and then silently dropped: a primary-model outage looked like
      // a delegation that simply failed, with the fallbacks never tried.
      model: {
        provider_id: request.model.provider,
        model: request.model.model,
        ...(request.model.fallbackModels.length ? { fallback_models: [...request.model.fallbackModels] } : {}),
      },
      ...(request.sessionId ? { session_id: request.sessionId } : {}),
      ...(request.interactionId ? { interaction_id: request.interactionId } : {}),
      execution: {
        ...(request.deadlineAt ? { deadline: request.deadlineAt } : {}),
        maximum_model_calls: request.maximumModelCalls,
        maximum_tool_calls: request.maximumToolCalls,
      },
    };
  }

  private async observe(executionId: string): Promise<void> {
    const tracked = this.tracked.get(executionId);
    if (!tracked) return;
    const { request, handle } = tracked;
    const base = { requestId: request.requestId, executionId, ...(request.sessionId ? { sessionId: request.sessionId } : {}), ...(request.interactionId ? { interactionId: request.interactionId } : {}) };
    try {
      const result = await handle.result;
      const usage = result.usage;
      this.emit({ type: "delegation.progress", ...base, modelCalls: usage.model_calls ?? 0, toolCalls: usage.tool_calls ?? 0, occurredAt: this.clock() });

      const structured = result.outputs.map((output) => readDelegationOutput(output)).find(Boolean);
      if (!structured) {
        // Prose is not a delegation result. Accepting it here would let the voice model
        // narrate a shape nothing validated.
        this.finish(executionId, { type: "delegation.failed", ...base, status: "failed", failure: { code: "DELEGATION_RESULT_INVALID", retryable: false }, occurredAt: this.clock() });
        return;
      }
      this.finish(executionId, { type: "delegation.completed", ...base, status: "completed", result: structured, occurredAt: this.clock() });
    } catch (cause) {
      const failure = toFailure(cause);
      const cancelled = failure.code === "EXECUTION_CANCELLED" || failure.code === "EXECUTION_DEADLINE_EXCEEDED";
      this.finish(executionId, cancelled
        ? { type: "delegation.cancelled", ...base, status: "cancelled", failure, occurredAt: this.clock() }
        : { type: "delegation.failed", ...base, status: "failed", failure, occurredAt: this.clock() });
    }
  }

  /** Terminal transitions are idempotent: a cancellation racing a completion must publish one outcome. */
  private finish(executionId: string, event: DelegationEvent): void {
    const tracked = this.tracked.get(executionId);
    if (!tracked || tracked.terminal) return;
    tracked.terminal = true;
    this.tracked.delete(executionId);
    this.emit(event);
  }

  public async cancel(executionId: string, reason = "cancelled"): Promise<void> {
    const tracked = this.tracked.get(executionId);
    if (!tracked || tracked.terminal) return;
    const { request } = tracked;
    // The terminal outcome is claimed before the handle is cancelled. Cancelling first
    // lets the resulting rejection reach `observe` and publish a generic
    // EXECUTION_CANCELLED, losing the specific reason the caller gave.
    this.finish(executionId, {
      type: "delegation.cancelled",
      requestId: request.requestId,
      executionId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.interactionId ? { interactionId: request.interactionId } : {}),
      status: "cancelled",
      failure: { code: reason, retryable: false },
      occurredAt: this.clock(),
    });
    await tracked.handle.cancel().catch(() => undefined);
  }

  /**
   * Session closure only cancels delegations that asked for it. Silently killing work the
   * caller marked as survivable would lose a result the user is still waiting for.
   */
  public async closeSession(sessionId: string): Promise<void> {
    const affected = [...this.tracked.values()].filter((entry) => entry.request.sessionId === sessionId && entry.request.cancelOnSessionClose);
    await Promise.all(affected.map((entry) => this.cancel(entry.request.executionId, "SESSION_CLOSED")));
  }

  public activeExecutionIds(): string[] { return [...this.tracked.keys()]; }

  /** Cancels everything still in flight. Used on runtime shutdown so no execution outlives the process. */
  public async stop(): Promise<void> {
    await Promise.all([...this.tracked.keys()].map((executionId) => this.cancel(executionId, "RUNTIME_STOPPED")));
    this.listeners.clear();
  }
}

/** Failures cross this boundary as a code and a retry flag only — never a provider stack trace. */
function toFailure(cause: unknown): DelegationFailure {
  const error = typeof cause === "object" && cause !== null ? cause as { code?: unknown; retryable?: unknown; context?: { status?: unknown } } : undefined;
  const code = error?.code === undefined ? "DELEGATION_FAILED" : String(error.code);
  const retryable = Boolean(error?.retryable);
  // A quota refusal and a broken integration both arrived as MODEL_PROVIDER_FAILED, and
  // they call for completely different actions. The status is a number, not content.
  if (error?.context?.status === 429) return { code: "MODEL_RATE_LIMITED", retryable: true };
  return { code, retryable };
}
