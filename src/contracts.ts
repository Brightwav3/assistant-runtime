export type InteractionMode = "native_realtime" | "modular";
export type InteractionState = "idle" | "activating" | "active" | "ending" | "failed";
export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface ComponentHealth { state: HealthState; detail?: string }
export interface RuntimeComponent {
  id: string; required?: boolean; start(): Promise<void>; stop(): Promise<void>; health(): Promise<ComponentHealth>;
  capabilities?(): Promise<Record<string, unknown>>;
}
export interface Activation { activationId: string; timestamp: string; source?: string }
export interface ActivationSource extends RuntimeComponent { subscribe(handler: (activation: Activation) => void): () => void }
export interface NativeRealtimeDriver { open(input: { interactionId: string; signal: AbortSignal; onActivity?: () => void }): Promise<{ close(): Promise<void>; done: Promise<void> }> }
export interface RealtimeToolExecutor {
  discover(): Promise<RealtimeToolDeclaration[]>;
  execute(input: { callId: string; tool: string; arguments: Record<string, unknown>; sessionId?: string; signal?: AbortSignal }): Promise<{ content: string; isError?: boolean }>;
}
export interface ModularDriver { run(input: { interactionId: string; signal: AbortSignal; onActivity?: () => void }): Promise<void> }
export interface StatePublisher { set(input: { key: string; value: string | boolean; source: { sourceType: "system"; sourceId: string } }): Promise<unknown> }
export interface RuntimeConfig { assistantId: string; mode: InteractionMode; inactivityMs: number; state?: StatePublisher }
export interface InteractionStatus { interactionId: string; activationId?: string; mode: InteractionMode; state: InteractionState; startedAt: string }
export interface RuntimeStatus { state: "created" | "running" | "stopped"; interaction: InteractionStatus | null }
export interface AssistantHealth { state: HealthState; components: Record<string, ComponentHealth> }
export interface AssistantCapabilities { activation: boolean; nativeRealtime: boolean; modular: boolean; state: boolean }
export class AssistantRuntimeError extends Error {
  constructor(public readonly code: "RUNTIME_NOT_STARTED" | "CONFIGURATION_INVALID" | "MODE_UNAVAILABLE" | "INTERACTION_NOT_FOUND", message: string) { super(message); this.name = "AssistantRuntimeError"; }
}
import type { RealtimeDeliveryMode, RealtimeToolDeclaration } from "realtime-core";

/* ------------------------------------------------------------------ *
 * Delegation
 *
 * The voice model may *request* deeper work; it never owns it. Everything below
 * describes work the runtime accepted on the model's behalf, so that an immediate
 * acknowledgement can be truthful: the identity exists before the answer does.
 * ------------------------------------------------------------------ */

export type DelegationTerminalStatus = "completed" | "failed" | "cancelled";
/** What to do with a result that arrives after its session can no longer take it. */
export type LateResultPolicy = "queue" | "drop" | "persist";

export interface DelegationDeliveryPolicy { mode: RealtimeDeliveryMode; lateResult: LateResultPolicy }

export interface DelegationModelSelection {
  provider: string;
  model: string;
  /** Tried in the given order. Never selected at random, or a failure stops being reproducible. */
  fallbackModels: string[];
}

export interface DelegationRequest {
  requestId: string;
  executionId: string;
  sessionId?: string;
  interactionId?: string;
  goal: string;
  transcript?: string;
  selectedMemoryIds: string[];
  /** Explicitly chosen context. The delegated model never receives the whole store. */
  selectedContext: Array<{ sourceId: string; text: string; kind: "memory" | "episode" }>;
  model: DelegationModelSelection;
  deadlineAt?: string;
  cancelOnSessionClose: boolean;
  maximumModelCalls: number;
  maximumToolCalls: number;
  delivery: DelegationDeliveryPolicy;
}

export interface DelegationAccepted {
  requestId: string;
  executionId: string;
  status: "accepted";
  /**
   * An instruction to the voice model, not a sentence the runtime speaks. The model
   * chooses its own natural wording; what it may not do is claim a result.
   */
  assistantInstruction: { type: "acknowledge-background-work"; text: string; doNotInventResult: true };
}

export interface DelegationFailure { code: string; retryable: boolean }

export interface DelegationMemoryReference {
  memoryId: string;
  score?: number;
  matchReasons?: string[];
  provenance: { sourceType: string; sourceId?: string };
}

export interface DelegationStructuredResult {
  schema: "delegation.result.v1";
  summary?: string;
  data: Record<string, unknown>;
  references: DelegationMemoryReference[];
}

export interface DelegationEventBase {
  requestId: string;
  executionId: string;
  sessionId?: string;
  interactionId?: string;
  occurredAt: string;
}

export type DelegationEvent =
  | ({ type: "delegation.created" } & DelegationEventBase)
  | ({ type: "delegation.accepted" } & DelegationEventBase)
  | ({ type: "delegation.started" } & DelegationEventBase)
  | ({ type: "delegation.progress"; modelCalls: number; toolCalls: number } & DelegationEventBase)
  | ({ type: "delegation.completed"; status: "completed"; result: DelegationStructuredResult } & DelegationEventBase)
  | ({ type: "delegation.failed"; status: "failed"; failure: DelegationFailure } & DelegationEventBase)
  | ({ type: "delegation.cancelled"; status: "cancelled"; failure: DelegationFailure } & DelegationEventBase)
  | ({ type: "delegation.delivery.queued"; delivery: DelegationDeliveryPolicy } & DelegationEventBase)
  | ({ type: "delegation.delivery.sent"; delivery: DelegationDeliveryPolicy; source: "delegation" } & DelegationEventBase)
  | ({ type: "delegation.delivery.degraded"; delivery: DelegationDeliveryPolicy; reason: string } & DelegationEventBase)
  | ({ type: "delegation.delivery.dropped"; delivery: DelegationDeliveryPolicy; reason: string } & DelegationEventBase);

export interface DelegationBroker {
  accept(input: Omit<DelegationRequest, "executionId">): Promise<DelegationAccepted>;
  cancel(executionId: string, reason?: string): Promise<void>;
  onEvent(listener: (event: DelegationEvent) => void): () => void;
  closeSession(sessionId: string): Promise<void>;
}
