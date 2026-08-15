/**
 * Delivers a finished delegation back into the conversation that asked for it.
 *
 * The hard rule this file exists to enforce: a background result is never replayed as
 * something the user said. It travels as a context event with `source: "delegation"`,
 * so the voice model — and every trace afterwards — can tell the difference between
 * what the user asked and what the runtime found.
 *
 * Scheduling is a policy, not a preference. `interrupt` cuts the current answer off,
 * `when_idle` waits for a gap, and `silent` never speaks at all.
 */

import { randomUUID } from "node:crypto";
import type { RealtimeContextEvent, RealtimeSpeechSession } from "realtime-core";
import type { DelegationDeliveryPolicy, DelegationEvent, DelegationStructuredResult } from "../contracts.js";

export interface DeliverySessionBinding {
  sessionId: string;
  session: RealtimeSpeechSession;
  /** Advertised by the provider. When false the runtime takes its explicit degraded path. */
  contextInjection: boolean;
}

export interface DeliverySchedulerOptions {
  emit?: (event: DelegationEvent) => void;
  /** Bounded so a session that never goes idle cannot accumulate results without limit. */
  maxQueueLength?: number;
  clock?: () => string;
}

interface PendingDelivery {
  event: Extract<DelegationEvent, { type: "delegation.completed" }>;
  delivery: DelegationDeliveryPolicy;
}

export class DelegationDeliveryScheduler {
  private readonly sessions = new Map<string, DeliverySessionBinding>();
  private readonly speaking = new Set<string>();
  private readonly queues = new Map<string, PendingDelivery[]>();
  private readonly closed = new Set<string>();
  private readonly idleListeners = new Map<string, Set<() => void>>();
  private readonly clock: () => string;
  private readonly maxQueueLength: number;

  public constructor(private readonly options: DeliverySchedulerOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxQueueLength = options.maxQueueLength ?? 8;
  }

  public bind(binding: DeliverySessionBinding): void {
    this.sessions.set(binding.sessionId, binding);
    this.closed.delete(binding.sessionId);
  }

  /** A reconnect rebinds the same session id to a new transport and drains what was waiting. */
  public async rebind(binding: DeliverySessionBinding): Promise<void> {
    this.bind(binding);
    this.speaking.delete(binding.sessionId);
    await this.drain(binding.sessionId);
  }

  public markOutputStarted(sessionId: string): void { this.speaking.add(sessionId); }

  public async markOutputFinished(sessionId: string): Promise<void> {
    this.speaking.delete(sessionId);
    await this.drain(sessionId);
    this.notifyIdle(sessionId);
  }

  /**
   * Whether the assistant is currently between outputs on this session.
   *
   * Exposed rather than reimplemented elsewhere: `when_idle` delivery and a handoff
   * cutover are asking the same question, and two answers to it would drift apart the
   * first time one of them learned about a new kind of output.
   */
  public isIdle(sessionId: string): boolean { return !this.speaking.has(sessionId); }

  /** Called each time this session finishes an output. Returns an unsubscribe function. */
  public onIdle(sessionId: string, listener: () => void): () => void {
    const listeners = this.idleListeners.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.idleListeners.set(sessionId, listeners);
    return () => listeners.delete(listener);
  }

  private notifyIdle(sessionId: string): void {
    for (const listener of [...(this.idleListeners.get(sessionId) ?? [])]) listener();
  }

  public async closeSession(sessionId: string): Promise<void> {
    this.closed.add(sessionId);
    this.sessions.delete(sessionId);
    this.speaking.delete(sessionId);
    const queued = this.queues.get(sessionId) ?? [];
    this.queues.delete(sessionId);
    for (const pending of queued) {
      // `queue` and `persist` both keep the result alive for a later turn; only `drop`
      // discards it, and even then it says so rather than vanishing.
      if (pending.delivery.lateResult === "drop") this.report({ ...pending.event, type: "delegation.delivery.dropped", delivery: pending.delivery, reason: "SESSION_CLOSED", occurredAt: this.clock() } as DelegationEvent);
      else this.report({ ...pending.event, type: "delegation.delivery.queued", delivery: pending.delivery, occurredAt: this.clock() } as DelegationEvent);
    }
  }

  /**
   * Accepts a completed delegation. Returns once the result has been sent, queued, or
   * explicitly dropped — never leaving it in an unobservable state.
   */
  public async deliver(event: Extract<DelegationEvent, { type: "delegation.completed" }>, delivery: DelegationDeliveryPolicy): Promise<void> {
    // Silent is decided before the session is looked at, because a silent result was never
    // going to a session. Compaction is the case that matters: it deliberately carries no
    // session id so it can outlive the session it is replacing, and reporting that as
    // NO_SESSION described a working handoff as a lost answer — in the operator console it
    // read as "výsledek zahozen" at the exact moment the user was waiting for one.
    if (delivery.mode === "silent") {
      // Silent is a real outcome, not a no-op: it is recorded so the result is auditable
      // even though nothing is spoken.
      this.report({ ...event, type: "delegation.delivery.sent", delivery, source: "delegation", occurredAt: this.clock() } as DelegationEvent);
      return;
    }
    const sessionId = event.sessionId;
    if (!sessionId) {
      this.report({ ...event, type: "delegation.delivery.dropped", delivery, reason: "NO_SESSION", occurredAt: this.clock() } as DelegationEvent);
      return;
    }
    const binding = this.sessions.get(sessionId);
    if (!binding || this.closed.has(sessionId)) {
      if (delivery.lateResult === "drop") this.report({ ...event, type: "delegation.delivery.dropped", delivery, reason: "SESSION_UNAVAILABLE", occurredAt: this.clock() } as DelegationEvent);
      else this.enqueue(sessionId, { event, delivery });
      return;
    }
    if (delivery.mode === "when_idle" && this.speaking.has(sessionId)) {
      this.enqueue(sessionId, { event, delivery });
      return;
    }
    await this.send(binding, { event, delivery });
  }

  private enqueue(sessionId: string, pending: PendingDelivery): void {
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.length >= this.maxQueueLength) {
      const evicted = queue.shift()!;
      this.report({ ...evicted.event, type: "delegation.delivery.dropped", delivery: evicted.delivery, reason: "QUEUE_OVERFLOW", occurredAt: this.clock() } as DelegationEvent);
    }
    queue.push(pending);
    this.queues.set(sessionId, queue);
    this.report({ ...pending.event, type: "delegation.delivery.queued", delivery: pending.delivery, occurredAt: this.clock() } as DelegationEvent);
  }

  private async drain(sessionId: string): Promise<void> {
    const binding = this.sessions.get(sessionId);
    const queue = this.queues.get(sessionId);
    if (!binding || !queue?.length) return;
    this.queues.set(sessionId, []);
    for (const pending of queue) await this.send(binding, pending);
  }

  private async send(binding: DeliverySessionBinding, pending: PendingDelivery): Promise<void> {
    const { event, delivery } = pending;
    if (delivery.mode === "interrupt") {
      // Interrupting first means the result is not appended to an answer it contradicts.
      await binding.session.interrupt().catch(() => undefined);
    }

    const contextEvent = toContextEvent(binding.sessionId, event, delivery.mode, this.clock());
    const native = binding.contextInjection && typeof binding.session.sendContextEvent === "function";
    if (!native) {
      // The degraded path is announced, not hidden: a reader of the trace must be able to
      // tell native injection from a fallback that merely looked the same.
      this.report({ ...event, type: "delegation.delivery.degraded", delivery, reason: "CONTEXT_INJECTION_UNAVAILABLE", occurredAt: this.clock() } as DelegationEvent);
      await binding.session.sendText(JSON.stringify({ delegation_result: contextEvent.content, source: "delegation", status: event.status }));
    } else {
      await binding.session.sendContextEvent!(contextEvent);
    }
    this.report({ ...event, type: "delegation.delivery.sent", delivery, source: "delegation", occurredAt: this.clock() } as DelegationEvent);
  }

  private report(event: DelegationEvent): void { this.options.emit?.(event); }

  public queuedCount(sessionId: string): number { return this.queues.get(sessionId)?.length ?? 0; }
}

export function toContextEvent(
  sessionId: string,
  event: Extract<DelegationEvent, { type: "delegation.completed" }>,
  mode: DelegationDeliveryPolicy["mode"],
  timestamp: string,
): RealtimeContextEvent {
  return {
    eventId: `ctx_${randomUUID()}`,
    sessionId,
    ...(event.interactionId ? { interactionId: event.interactionId } : {}),
    executionId: event.executionId,
    source: "delegation",
    type: "delegation.result",
    status: "completed",
    delivery: mode,
    content: { type: "structured", value: event.result as unknown as Record<string, unknown> },
    timestampMs: Date.parse(timestamp) || Date.now(),
  };
}

export type { DelegationStructuredResult };
