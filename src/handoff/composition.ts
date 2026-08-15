/**
 * Assembles the handoff parts into one object a composition root can hold.
 *
 * Deliberately *not* wired into `composition.ts` yet. The live path today binds delegation
 * delivery to the physical session id, which is the same thing as the logical id only for
 * as long as there is exactly one session per conversation. Introducing the logical id
 * there is a real change to a path that is verified on hardware and cannot be verified
 * here, so it is left for a change that can be tested where it runs.
 *
 * What this file does provide is the whole assembly, tested, so that wiring is a matter of
 * calling one function and rebinding delivery to `logicalSessionId`.
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
