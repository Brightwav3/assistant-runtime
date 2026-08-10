export type InteractionMode = "native_realtime" | "modular";
export type InteractionState = "idle" | "activating" | "active" | "ending" | "failed";
export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface ComponentHealth { state: HealthState; detail?: string }
export interface RuntimeComponent {
  id: string; required?: boolean; start(): Promise<void>; stop(): Promise<void>; health(): Promise<ComponentHealth>;
  capabilities?(): Promise<Record<string, boolean | string[]>>;
}
export interface Activation { activationId: string; timestamp: string; source?: string }
export interface ActivationSource extends RuntimeComponent { subscribe(handler: (activation: Activation) => void): () => void }
export interface NativeRealtimeDriver { open(input: { interactionId: string; signal: AbortSignal }): Promise<{ close(): Promise<void>; done: Promise<void> }> }
export interface ModularDriver { run(input: { interactionId: string; signal: AbortSignal }): Promise<void> }
export interface StatePublisher { set(input: { key: string; value: string | boolean; source: { sourceType: "system"; sourceId: string } }): Promise<unknown> }
export interface RuntimeConfig { assistantId: string; mode: InteractionMode; inactivityMs: number; state?: StatePublisher }
export interface InteractionStatus { interactionId: string; activationId?: string; mode: InteractionMode; state: InteractionState; startedAt: string }
export interface RuntimeStatus { state: "created" | "running" | "stopped"; interaction: InteractionStatus | null }
export interface AssistantHealth { state: HealthState; components: Record<string, ComponentHealth> }
export interface AssistantCapabilities { activation: boolean; nativeRealtime: boolean; modular: boolean; state: boolean }
export class AssistantRuntimeError extends Error {
  constructor(public readonly code: "RUNTIME_NOT_STARTED" | "CONFIGURATION_INVALID" | "MODE_UNAVAILABLE" | "INTERACTION_NOT_FOUND", message: string) { super(message); this.name = "AssistantRuntimeError"; }
}
