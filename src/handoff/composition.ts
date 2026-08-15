/**
 * Assembles the handoff parts into one object a composition root can hold.
 *
 * `composition.ts` builds one of these per interaction, and delegation delivery is bound to
 * `logicalSessionId` rather than to the session that happens to be rendering it. That
 * binding is the reason this assembly can exist at all: a physical id changes at every
 * commit, and every queued delegation keyed to it would be stranded.
 *
 * Whether the cutover is inaudible on real hardware is not decided here, and cannot be
 * decided from a development machine. What is decided here is that nothing is left half
 * owned: one attempt at a time, one terminal outcome, one owner of audio at every instant.
 *
 * ADR 0002 — docs/decisions/0002-delegated-results-are-never-the-user.md
 *   The binding to `logicalSessionId` is why this assembly can exist at all.
 */

import type { DelegationBroker, DelegationModelSelection, StatePublisher } from "../contracts.js";
import { DelegatedCompaction, type CompactionTranscriptSource } from "./compaction.js";
import { ContextThresholdTrigger, RuntimeContextEstimator } from "./context-estimator.js";
import { HandoffCoordinator } from "./coordinator.js";
import type { HandoffEvent, HandoffSessionController } from "./contracts.js";
import { createEchoRebinder, type EchoReferenceOwner } from "./echo-rebind.js";
import { SessionIdleGate, type OutputIdleSource } from "./idle-gate.js";
import { HandoffMetrics } from "./metrics.js";
import { HandoffStatePublisher } from "./state-publisher.js";

export interface HandoffCompositionSettings {
  enabled: boolean;
  contextLimitTokens: number;
  prepareThreshold: number;
  readyTimeoutMs: number;
  idleWaitTimeoutMs: number;
}

export interface HandoffCompositionOptions {
  settings: HandoffCompositionSettings;
  assistantId: string;
  logicalSessionId: string;
  activePhysicalSessionId: string;
  controller: HandoffSessionController;
  broker: DelegationBroker;
  transcript: CompactionTranscriptSource;
  model: DelegationModelSelection;
  compactionDeadlineMs: number;
  /** The delivery scheduler. Reused so a handoff and `when_idle` delivery share one answer. */
  output: OutputIdleSource;
  state?: StatePublisher;
  echo?: EchoReferenceOwner;
  /**
   * Receives the compacted context the replacement was prefilled with, at the moment it is
   * produced. The runtime's own record of the conversation is reseeded from it, so that the
   * next compaction summarizes this summary and what followed rather than a window nothing
   * holds any more.
   */
  onCompacted?: (context: string) => void;
  trace?: (event: HandoffEvent) => void;
}

export interface HandoffComposition {
  coordinator: HandoffCoordinator;
  estimator: RuntimeContextEstimator;
  trigger: ContextThresholdTrigger;
  idle: SessionIdleGate;
  metrics: HandoffMetrics;
  /**
   * Call after recording a turn. Returns true when a handoff was started, so the caller can
   * see the decision rather than discovering it in a log.
   */
  maybePrepare(): boolean;
  /** Runs the full attempt: prepare, wait for a gap, commit. Resolves when it settles. */
  run(): Promise<void>;
  dispose(): void;
}

export function createHandoffComposition(options: HandoffCompositionOptions): HandoffComposition {
  const estimator = new RuntimeContextEstimator({ limitTokens: options.settings.contextLimitTokens });
  const trigger = new ContextThresholdTrigger(estimator, options.settings.prepareThreshold);
  const idle = new SessionIdleGate(options.output, options.logicalSessionId);
  const metrics = new HandoffMetrics();
  const statePublisher = options.state ? new HandoffStatePublisher(options.state, options.assistantId) : undefined;
  const rebindEcho = createEchoRebinder({ ...(options.echo ? { guard: options.echo } : {}) });

  let lastCompacted = "";
  const compaction = new DelegatedCompaction({
    broker: options.broker,
    transcript: options.transcript,
    model: options.model,
    deadlineMs: options.compactionDeadlineMs,
    emit: (event) => emit(event),
  });

  const coordinator = new HandoffCoordinator({
    logicalSessionId: options.logicalSessionId,
    activePhysicalSessionId: options.activePhysicalSessionId,
    controller: options.controller,
    context: {
      compact: async (identity) => {
        lastCompacted = await compaction.compact(identity);
        options.onCompacted?.(lastCompacted);
        return lastCompacted;
      },
    },
    readyTimeoutMs: options.settings.readyTimeoutMs,
    idleWaitTimeoutMs: options.settings.idleWaitTimeoutMs,
    idle,
    emit: (event) => emit(event),
  });

  function emit(event: HandoffEvent): void {
    metrics.handle(event);
    rebindEcho(event);
    void statePublisher?.handle(event);
    options.trace?.(event);
    if (event.type === "handoff.committed") {
      // The new window starts with what the replacement was actually prefilled with, so the
      // next threshold is measured against the session that exists rather than the one that
      // was replaced.
      estimator.reset({ text: lastCompacted });
      trigger.rearm();
    }
  }

  return {
    coordinator,
    estimator,
    trigger,
    idle,
    metrics,
    maybePrepare(): boolean {
      if (!options.settings.enabled) return false;
      return trigger.observe();
    },
    async run(): Promise<void> {
      await coordinator.prepare("context_threshold");
      if (coordinator.phase() !== "ready") return;
      await coordinator.commitWhenIdle();
    },
    dispose(): void { idle.dispose(); },
  };
}
