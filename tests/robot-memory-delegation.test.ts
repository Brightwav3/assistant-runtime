/**
 * The whole capability, end to end, with no API key, microphone, network, or audio.
 *
 * The user asks about "the new robot". The voice model delegates, keeps talking, and
 * the delegated text model does the real recall through Tool System. What comes back is
 * structured data — the voice model, not the runtime, turns it into the Czech sentence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { FakeRealtimeSpeechProvider, REALTIME_INPUT_FORMAT, RealtimeCore } from "realtime-core";
import { InMemoryMemoryStore, MemoryRuntime, type CreateMemoryInput } from "memory-core";
import { AllowlistPolicy, InMemoryTraceSink, ToolRegistry, ToolRuntime } from "tool-system";
import type { AcceptedExecution, IntelligenceRequest, IntelligenceResult } from "intelligence-core";

import { RuntimeDelegationBroker } from "../src/delegation/broker.js";
import { DelegationDeliveryScheduler } from "../src/delegation/delivery.js";
import { MEMORY_SEARCH_TOOL, MEMORY_VIEW_TOOL, memorySearchDeclaration, memorySearchHandler, memoryViewDeclaration, memoryViewHandler } from "../src/delegation/memory-tools.js";
import { INTELLIGENCE_DELEGATE_TOOL, intelligenceDelegateDeclaration, intelligenceDelegateHandler } from "../src/delegation/intelligence-tool.js";
import { ToolSystemRealtimeToolExecutor } from "../src/tool-bridge.js";
import type { DelegationEvent, DelegationStructuredResult } from "../src/contracts.js";

const SUBJECT = "user-1";
const SESSION = "session-1";

const fact = (memoryId: string, text: string, subjectId = SUBJECT): CreateMemoryInput & { memoryId: string } => ({
  memoryId,
  kind: "fact",
  content: { type: "text", text },
  scope: { type: "user", subjectId },
  provenance: { sourceType: "conversation", sourceId: "turn-1" },
  confidence: 0.8,
});

async function seededMemory(): Promise<MemoryRuntime> {
  const memory = new MemoryRuntime({ store: new InMemoryMemoryStore() });
  await memory.start();
  const at = "2026-08-01T00:00:00.000Z";
  const restore = (input: CreateMemoryInput & { memoryId: string }, status: "active" | "forgotten" = "active") =>
    memory.restore({ ...input, createdAt: at, updatedAt: at, status });

  await restore(fact("robot-mit", "novy robot z MIT pro laboratorni praci"));
  await restore(fact("robot-mars", "novy robot pro Mars misi"));
  await restore(fact("submarine-project", "novy robot v projektu s ponorkou"));
  // Negative controls: neither may reach the delegated model.
  await restore(fact("robot-forgotten", "novy robot ktery jsme zapomneli"), "forgotten");
  await restore(fact("robot-other-user", "novy robot jineho uzivatele", "user-2"));
  return memory;
}

async function delegatedToolRuntime(memory: MemoryRuntime): Promise<ToolRuntime> {
  const registry = new ToolRegistry();
  registry.register(memorySearchDeclaration(), memorySearchHandler({ memory, subjectId: SUBJECT }));
  registry.register(memoryViewDeclaration(), memoryViewHandler({ memory, subjectId: SUBJECT }));
  const runtime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: [MEMORY_SEARCH_TOOL, MEMORY_VIEW_TOOL] }), trace: new InMemoryTraceSink() });
  await runtime.start();
  return runtime;
}

/**
 * A scripted delegated text model. It runs a real Tool System loop — the tool calls and
 * their bounds are genuine — and returns structured data, never the spoken sentence.
 */
class ScriptedDelegatedModel {
  public readonly toolCalls: string[] = [];
  public constructor(private readonly tools: ToolRuntime) {}

  public accept(request: IntelligenceRequest): AcceptedExecution {
    const executionId = "exec-1";
    const result = (async (): Promise<IntelligenceResult> => {
      const search = await this.call(MEMORY_SEARCH_TOOL, { query: "novy robot" });
      const mit = await this.call(MEMORY_VIEW_TOOL, { memory_id: "robot-mit", before: 0, after: 0 });
      const mars = await this.call(MEMORY_VIEW_TOOL, { memory_id: "robot-mars", before: 0, after: 0 });

      const value: DelegationStructuredResult = {
        schema: "delegation.result.v1",
        summary: "three candidate memories about a new robot",
        data: {
          candidates: [
            { memoryId: "robot-mit", label: "robot z MIT" },
            { memoryId: "robot-mars", label: "robot pro Mars" },
            { memoryId: "submarine-project", label: "projekt s ponorkou" },
          ],
          evidence: { search, mit, mars },
        },
        references: [
          { memoryId: "robot-mit", score: 2, matchReasons: ["novy", "robot"], provenance: { sourceType: "conversation", sourceId: "turn-1" } },
          { memoryId: "robot-mars", score: 2, matchReasons: ["novy", "robot"], provenance: { sourceType: "conversation", sourceId: "turn-1" } },
          { memoryId: "submarine-project", score: 2, matchReasons: ["novy", "robot"], provenance: { sourceType: "conversation", sourceId: "turn-1" } },
        ],
      };
      return {
        request_id: request.request_id,
        execution_id: executionId,
        status: "completed",
        outputs: [{ type: "structured", value: value as unknown as Record<string, unknown> }],
        usage: { duration_ms: 5, model_calls: 3, tool_calls: this.toolCalls.length },
      };
    })();
    return { executionId, record: () => undefined, result, cancel: async () => undefined };
  }

  private async call(tool: string, args: Record<string, string | number>): Promise<string> {
    this.toolCalls.push(tool);
    const report = await this.tools.execute({ tool, args, requestId: `${tool}-${this.toolCalls.length}` });
    if (report.outcome.kind !== "result") throw new Error(`${tool} did not return a result`);
    return report.outcome.content;
  }
}

test("the robot-memory conversation completes end to end without inventing a result", async () => {
  const memory = await seededMemory();
  const delegatedTools = await delegatedToolRuntime(memory);
  const model = new ScriptedDelegatedModel(delegatedTools);

  const events: DelegationEvent[] = [];
  const broker = new RuntimeDelegationBroker({ intelligence: model, idFactory: () => "del-1" });
  broker.onEvent((event) => events.push(event));

  const delivery = new DelegationDeliveryScheduler({ emit: (event) => events.push(event) });

  // The voice model's only tool.
  const voiceRegistry = new ToolRegistry();
  voiceRegistry.register(intelligenceDelegateDeclaration(), intelligenceDelegateHandler({
    broker,
    model: { provider: "gemini", model: "gemini-2.5-flash", fallbackModels: [] },
    correlation: () => ({ sessionId: SESSION, interactionId: "interaction-1" }),
    maximumModelCalls: 4,
    maximumToolCalls: 8,
    cancelOnSessionClose: true,
    defaultDelivery: { mode: "when_idle", lateResult: "queue" },
  }));
  const voiceTools = new ToolRuntime({ registry: voiceRegistry, policy: new AllowlistPolicy({ allow: [INTELLIGENCE_DELEGATE_TOOL] }), trace: new InMemoryTraceSink() });
  await voiceTools.start();

  const provider = new FakeRealtimeSpeechProvider({ toolCalling: "async", contextInjection: true });
  const session = await new RealtimeCore(provider).connect({
    provider: "fake",
    inputFormat: REALTIME_INPUT_FORMAT,
    tools: await new ToolSystemRealtimeToolExecutor(voiceTools).discover(),
  });
  delivery.bind({ sessionId: SESSION, session, contextInjection: true });

  const observed: string[] = [];
  const reader = (async () => { for await (const event of session.events()) { observed.push(event.type); if (event.type === "session.closed") return; } })();

  // 1. The voice model asks for delegation and is answered immediately.
  const report = await voiceTools.execute({
    tool: INTELLIGENCE_DELEGATE_TOOL,
    args: { goal: "Najdi relevantní vzpomínky o novém robotovi", delivery: "when_idle", current_verbatim: "Co víte o novém robotovi?", current_meaning: "Uživatel se ptá na nového robota.", current_language: "cs", current_uncertain_parts: "[]" },
    requestId: "voice-call-1",
  });
  assert.equal(report.outcome.kind, "continuation");
  if (report.outcome.kind !== "continuation") throw new Error("expected a continuation");
  assert.equal(JSON.parse(report.outcome.acknowledgement).doNotInventResult, true);

  // 2. The user keeps talking while the delegated model works.
  await session.sendAudio({ streamId: "mic", timestampMs: 0, format: REALTIME_INPUT_FORMAT, data: new Int16Array(320) });

  // 3. The result arrives and is delivered into the same session.
  const completed = await new Promise<Extract<DelegationEvent, { type: "delegation.completed" }>>((resolve) => {
    broker.onEvent((event) => { if (event.type === "delegation.completed") resolve(event); });
  });
  await delivery.deliver(completed, { mode: "when_idle", lateResult: "queue" });

  // The delegated model used exactly the intended bounded tool calls.
  assert.deepEqual(model.toolCalls, [MEMORY_SEARCH_TOOL, MEMORY_VIEW_TOOL, MEMORY_VIEW_TOOL]);

  // Lifecycle order.
  assert.deepEqual(events.map((event) => event.type), [
    "delegation.created", "delegation.accepted", "delegation.started",
    "delegation.progress", "delegation.completed",
    "delegation.delivery.sent",
  ]);
  for (const event of events) {
    assert.equal(event.sessionId, SESSION);
    assert.equal(event.interactionId, "interaction-1");
  }

  // Only relevant, active, in-scope records reached the delegated model.
  const evidence = JSON.stringify(completed.result.data);
  assert.ok(evidence.includes("robot-mit"));
  assert.ok(evidence.includes("robot-mars"));
  assert.equal(evidence.includes("robot-forgotten"), false);
  assert.equal(evidence.includes("jineho uzivatele"), false);
  assert.ok(evidence.includes("score="), "scores survived to the model");
  assert.ok(evidence.includes("confidence="), "confidence survived to the model");
  assert.ok(evidence.includes("source=conversation"), "provenance survived to the model");

  // The result reached the same session as a labelled delegation context event.
  assert.equal(provider.contextEvents.length, 1);
  const context = provider.contextEvents[0]!;
  assert.equal(context.source, "delegation");
  assert.equal(context.sessionId, SESSION);
  assert.equal(context.executionId, "del-1");
  assert.equal(context.content.type, "structured");
  assert.deepEqual(
    (context.content as { value: DelegationStructuredResult }).value.references.map((reference) => reference.memoryId),
    ["robot-mit", "robot-mars", "submarine-project"],
  );

  // 4. Only now does the voice model produce the spoken sentence — from the structured
  //    result, not from anything the runtime wrote.
  const spoken = formulateCzechResponse(context.content as { value: DelegationStructuredResult });
  assert.equal(spoken, "Našel jsem tři možnosti. Myslíte robota z MIT, robota pro Mars, nebo projekt s ponorkou?");

  await session.close();
  await reader;

  // The delegated result is never a user transcript.
  const transcripts = observed.filter((type) => type === "transcript.final");
  assert.equal(transcripts.length, 1, "the only final transcript is the user's own speech");
  assert.equal(JSON.stringify(observed).includes("robot-mit"), false);
});

/** Stands in for the voice model. Deliberately outside the runtime: this sentence is the model's job. */
function formulateCzechResponse(content: { value: DelegationStructuredResult }): string {
  const candidates = content.value.data.candidates as Array<{ label: string }>;
  const [first, second, third] = candidates.map((candidate) => candidate.label);
  return `Našel jsem tři možnosti. Myslíte ${first!.replace("robot z", "robota z")}, ${second!.replace("robot pro", "robota pro")}, nebo ${third}?`;
}
