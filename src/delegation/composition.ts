/**
 * Composes the two model roles into one assistant.
 *
 * The voice model and the delegation model are configured, built, and given tools
 * separately. That separation is the point of this file: the voice frontend gets
 * `intelligence_delegate` and whatever conversation control it needs, and nothing else;
 * the delegated text model gets the downstream capability catalogue and never
 * `intelligence_delegate`, which would let it delegate to itself.
 */

import {
  ActionRuntime,
  GeminiModelProvider,
  IntelligenceRuntime,
  ModelGateway,
  ModelRouter,
  PriceCatalog,
  ProductionModelGateway,
  type ModelPriceEntry,
} from "intelligence-core";
import { AllowlistPolicy, ToolRegistry, ToolRuntime } from "tool-system";
import type { MemoryRuntime } from "memory-core";

import type { DelegationSettings, UsageSettings } from "../config.js";
import { ToolSystemPolicyClient, ToolSystemToolClient } from "../tool-bridge.js";
import { RuntimeUsageStore } from "../observability/usage-store.js";
import { RuntimeDelegationBroker } from "./broker.js";
import { DelegationDeliveryScheduler } from "./delivery.js";
import {
  MEMORY_SEARCH_TOOL,
  MEMORY_VIEW_TOOL,
  memorySearchDeclaration,
  memorySearchHandler,
  memoryViewDeclaration,
  memoryViewHandler,
} from "./memory-tools.js";
import { INTELLIGENCE_DELEGATE_TOOL, intelligenceDelegateDeclaration, intelligenceDelegateHandler } from "./intelligence-tool.js";
import type { DelegationEvent } from "../contracts.js";

export interface DelegationCompositionInput {
  delegation: DelegationSettings;
  usage: UsageSettings;
  memory: MemoryRuntime;
  subjectId: string;
  apiKey?: string;
  priceCatalog?: ModelPriceEntry[];
  /** Supplies the live conversation identity at call time. */
  correlation: () => { sessionId?: string; interactionId?: string };
  trace?: (event: Record<string, unknown>) => void;
  /** Test seam: replaces the Gemini text provider without touching the rest of the wiring. */
  modelGateway?: ModelGateway;
}

export interface DelegationComposition {
  broker: RuntimeDelegationBroker;
  delivery: DelegationDeliveryScheduler;
  intelligence: IntelligenceRuntime;
  /** The downstream catalogue given to the delegated model. Never reaches the voice model. */
  delegatedTools: ToolRuntime;
  usage: RuntimeUsageStore;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Registers the voice-facing declaration. Called with the *voice* registry, deliberately separate. */
export function registerVoiceDelegationTool(registry: ToolRegistry, composition: DelegationComposition, input: DelegationCompositionInput): string {
  registry.register(intelligenceDelegateDeclaration(), intelligenceDelegateHandler({
    broker: composition.broker,
    model: { provider: input.delegation.provider, model: input.delegation.model, fallbackModels: [...input.delegation.fallbackModels] },
    correlation: input.correlation,
    deadlineMs: input.delegation.deadlineMs,
    maximumModelCalls: input.delegation.maximumModelCalls,
    maximumToolCalls: input.delegation.maximumToolCalls,
    cancelOnSessionClose: input.delegation.cancelOnSessionClose,
    defaultDelivery: { mode: input.delegation.defaultDelivery, lateResult: input.delegation.lateResultPolicy },
  }));
  return INTELLIGENCE_DELEGATE_TOOL;
}

export function createDelegation(input: DelegationCompositionInput): DelegationComposition {
  const trace = input.trace ?? (() => undefined);

  const catalog = new PriceCatalog({
    entries: input.priceCatalog ?? [],
    unknown_cost_policy: input.usage.unknownCostPolicy,
  });
  const usage = new RuntimeUsageStore({
    catalog,
    maxRecords: input.usage.maxRecords,
    ...(input.usage.enabled && input.usage.path ? { path: input.usage.path } : {}),
  });

  const models = input.modelGateway ?? new ModelGateway();
  if (!input.modelGateway) models.register(new GeminiModelProvider({ ...(input.apiKey ? { api_key: input.apiKey } : {}) }));

  const gateway = new ProductionModelGateway({
    models,
    // Fallbacks are only ever the explicitly configured list, in order.
    router: new ModelRouter({ default_provider_id: input.delegation.provider, fallback_provider_ids: [] }),
    meter: usage,
    usage_context: { role: "delegation", operation: "chat" },
    ...(input.usage.maximumCost === undefined ? {} : { maximum_cost: input.usage.maximumCost }),
  });

  // The delegated model's own catalogue. intelligence_delegate is absent by construction.
  const delegatedRegistry = new ToolRegistry();
  delegatedRegistry.register(memorySearchDeclaration(), memorySearchHandler({ memory: input.memory, subjectId: input.subjectId }));
  delegatedRegistry.register(memoryViewDeclaration(), memoryViewHandler({ memory: input.memory, subjectId: input.subjectId }));
  const delegatedTools = new ToolRuntime({
    registry: delegatedRegistry,
    policy: new AllowlistPolicy({ allow: [MEMORY_SEARCH_TOOL, MEMORY_VIEW_TOOL] }),
    // Without this the delegated model's tool calls happen entirely invisibly: the
    // operator sees a delegation start and an answer appear, with nothing in between.
    // Parameter *names* only — Tool System's trace never carries argument values.
    trace: {
      record: (entry) => trace({
        type: "delegation.tool",
        tool: entry.tool,
        outcome: entry.outcomeKind,
        durationMs: entry.durationMs,
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      }),
    },
  });

  const action = new ActionRuntime({
    models: gateway,
    provider_id: input.delegation.provider,
    model: input.delegation.model,
    tools: new ToolSystemToolClient(delegatedTools),
    policy: new ToolSystemPolicyClient(),
    maximum_iterations: input.delegation.maximumModelCalls,
  });

  const intelligence = new IntelligenceRuntime({ action });
  const broker = new RuntimeDelegationBroker({ intelligence });
  const delivery = new DelegationDeliveryScheduler({
    emit: (event: DelegationEvent) => trace({ type: event.type, executionId: event.executionId, ...(event.sessionId ? { sessionId: event.sessionId } : {}) }),
  });

  // Terminal delegation events flow straight into delivery; nothing else may speak them.
  broker.onEvent((event) => {
    trace({ type: event.type, executionId: event.executionId, ...(event.sessionId ? { sessionId: event.sessionId } : {}) });
    if (event.type !== "delegation.completed") return;
    void delivery.deliver(event, { mode: input.delegation.defaultDelivery, lateResult: input.delegation.lateResultPolicy });
  });

  return {
    broker,
    delivery,
    intelligence,
    delegatedTools,
    usage,
    start: async () => {
      await usage.load();
      await delegatedTools.start();
      await intelligence.start();
    },
    // Stopped in reverse order: the broker first, so no new work is admitted while the
    // pieces it depends on are shutting down.
    stop: async () => {
      await broker.stop();
      await intelligence.stop().catch(() => undefined);
      await delegatedTools.stop();
      await usage.flush();
    },
  };
}
