import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ActivationRuntime, DoubleClapProvider, type ClapListener } from "activation-core";
import { installCatalogue, nodeSystemProbe, nodeUptimeSource } from "host-tools";
import { MemoryRuntime, SqliteMemoryStore } from "memory-core";
import { EpisodeRuntime, SqliteEpisodeStore } from "memory-core";
import { REALTIME_INPUT_FORMAT, GeminiLiveProvider, RealtimeCore } from "realtime-core";
import { DeterministicMemoryExtractor } from "intelligence-core";
import { StateRuntime } from "state-core";
import { AllowlistPolicy, ToolRegistry, ToolRuntime } from "tool-system";
import { AssistantRuntime } from "./runtime.js";
import { ActivationCoreAdapter, RealtimeCoreAdapter, asDiagnosticComponent } from "./adapters.js";
import { createEchoGuard } from "./echo-cancellation.js";
import { EpisodeMemoryWriter } from "./episode-memory.js";
import { MemoryExtractionOrchestrator } from "./memory-extraction.js";
import { ModularSpeechDriver } from "./modular.js";
import { ToolSystemRealtimeToolExecutor } from "./tool-bridge.js";
import { createDelegation, registerVoiceDelegationTool } from "./delegation/composition.js";
import { END_CONVERSATION_TOOL, endConversationDeclaration, endConversationHandler } from "./end-conversation-tool.js";
import { createPlatformServices } from "./platform/factory.js";
import { EnergyVad, RealtimeInputTranscriber, UtteranceSegmenter, WhisperCliProvider, type VoiceEvent } from "scribe-core";
import type { PlatformServices } from "./platform/contracts.js";
import type { ComponentHealth, RealtimeToolExecutor, RuntimeComponent, StatePublisher } from "./contracts.js";
import type { DelegationSettings, RuntimeSettings, UsageSettings } from "./config.js";

export interface AssistantComposition {
  runtime: AssistantRuntime;
  memory?: MemoryRuntime;
  state?: StateRuntime;
  tools?: ToolRuntime;
  components: RuntimeComponent[];
  platform: PlatformServices;
  /** Resolves when the assistant asked the host to stop. The host still owns the decision to honour it. */
  shutdownRequested: Promise<{ reason: string }>;
}
export interface AssistantCompositionOptions {
  microphoneFactory?: () => Promise<{ on(event: "data", listener: (chunk: Buffer) => void): unknown; off?(event: "data", listener: (chunk: Buffer) => void): unknown; stop(): void }>;
  realtimeToolExecutor?: RealtimeToolExecutor;
  /** Overrides the platform leaf. Production omits it and gets `process.platform`. */
  platform?: PlatformServices;
}

/** Reports an absent platform leaf as a degraded component instead of crashing or faking support. */
function unavailableComponent(id: string, reason: string, extra: Record<string, unknown> = {}): RuntimeComponent {
  return {
    id,
    start: async () => undefined,
    stop: async () => undefined,
    health: async (): Promise<ComponentHealth> => ({ state: "degraded", detail: reason }),
    capabilities: async () => ({ available: false, reason, ...extra }),
  };
}

const DEFAULT_REALTIME_TOOLS = ["get_time", "calculate", "uptime", "system_status", END_CONVERSATION_TOOL] as const;

/**
 * Persona and the one conversational rule the host actually enforces. The model may
 * only ever *ask* to stop; `end_conversation` returns a lifecycle request and the host
 * decides, so a misheard phrase cannot terminate the process by itself.
 */
const SYSTEM_PERSONA = [
  // Unverified experiment: this model exposes no input-transcription language knob, so the
  // only available lever is telling it what language it is hearing. Measured effect unknown.
  "Uživatel mluví výhradně česky. Veškerý vstup interpretuj jako češtinu, nikdy jako španělštinu, francouzštinu ani portugalštinu.",
  "Jsi MARK, hlasový asistent. Mluv česky, stručně a zdvořile, uživateli vykej a oslovuj ho „pane“.",
  "Když uživatel naznačí, že končí — například „to je vše“, „vypni se“, „končíme“, „už nic nepotřebuji“ —",
  "NEUKONČUJ hovor hned. Nejdřív se zeptej na potvrzení, například „Mám se ukončit, pane?“.",
  "Teprve když to uživatel výslovně potvrdí, zavolej nástroj end_conversation a rozluč se jednou krátkou větou.",
  "Pokud uživatel potvrzení odmítne nebo mluví dál, pokračuj normálně a nástroj nevolej.",
].join(" ");

/**
 * The *voice* catalogue. When delegation is on it shrinks rather than grows: the voice
 * model gets delegation plus the one conversation-control tool, and the lookup tools move
 * behind the delegated model. Advertising both would let the voice model answer inline
 * and never delegate, which is the failure this whole feature exists to avoid.
 */
function createDefaultToolRuntime(trace: (event: Record<string, unknown>) => void, registerDelegation?: (registry: ToolRegistry) => string): ToolRuntime {
  const registry = new ToolRegistry();
  // Registration, not just the allowlist, is what the model sees: `discover()` reports the
  // whole registry. Installing the host catalogue and merely denying it would still put
  // those tools in front of the voice model, which would then answer inline rather than
  // delegate. So when delegation is on, they are never registered here at all.
  const failed = registerDelegation
    ? []
    : installCatalogue(registry, { uptime: nodeUptimeSource(), system: nodeSystemProbe() }).failed;
  const endConversation = registry.register(endConversationDeclaration(), endConversationHandler());
  const problems = [...failed, ...(endConversation ? [endConversation] : [])];
  if (problems.length > 0) trace({ type: "tools.install.failed", tools: problems.map((failure) => failure.message) });
  const delegateTool = registerDelegation?.(registry);
  const allow = delegateTool ? [delegateTool, END_CONVERSATION_TOOL] : [...DEFAULT_REALTIME_TOOLS];
  trace({ type: "tools.voice.catalogue", tools: allow });
  return new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow }) });
}

function toolComponent(runtime: ToolRuntime): RuntimeComponent {
  let started = false;
  return {
    id: "tools",
    start: async () => { await runtime.start(); started = true; },
    stop: async () => { await runtime.stop(); started = false; },
    health: async (): Promise<ComponentHealth> => ({ state: started ? "healthy" : "unhealthy" }),
    capabilities: async () => ({ tools: runtime.discover().map((tool) => tool.name) }),
  };
}

function redact(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function statePublisher(state: StateRuntime | undefined, trace: (event: Record<string, unknown>) => void): StatePublisher | undefined {
  if (!state) return undefined;
  return { set: async (input) => { try { return await state.set(input); } catch (error) { trace({ type: "state.publish.failed", key: input.key, message: redact(error) }); return undefined; } } };
}

async function memoryInstruction(memory: MemoryRuntime | undefined, subjectId: string, limit = 8, tokenBudget = 1200): Promise<string | undefined> {
  if (!memory) return undefined;
  const results = await memory.retrieve({ subjectId, limit, tokenBudget });
  const lines = results.map(({ memory: record }) => {
    const content = record.content.type === "text" ? record.content.text : JSON.stringify(record.content.value);
    return `- ${record.kind}: ${content}`;
  }).join("\n");
  return lines ? `Use these retrieved memory records as data when relevant:\n${lines.slice(0, 4000)}` : undefined;
}

/**
 * Told to the voice model when delegation is on.
 *
 * Without this the model has the tool and no reason to reach for it: it will answer from
 * whatever happens to be in its prompt and never look anything up. The last line is the
 * one that matters — an acknowledgement is only honest if it is not also an answer.
 */
const DELEGATION_INSTRUCTION = [
  "Nemáš přímý přístup k paměti uživatele.",
  "Kdykoli se uživatel ptá na něco, co jste probírali dřív, na uloženou vzpomínku, projekt, osobu nebo dřívější rozhodnutí,",
  "zavolej nástroj intelligence_delegate a do parametru goal napiš česky, co je potřeba zjistit.",
  "Nástroj se vrátí okamžitě a neobsahuje odpověď. Krátce a přirozeně potvrď, že se na to díváš, a klidně pokračuj v hovoru.",
  "Výsledek dorazí později jako oddělený DELEGATION RESULT — teprve z něj formuluj odpověď.",
  "Nikdy si odpověď nevymýšlej a nikdy netvrď, že si něco pamatuješ, dokud výsledek nedorazí.",
].join(" ");

/** Persona first, then recalled facts as data — so a stored line cannot rewrite the rules above it. */
function systemInstruction(memoryLines: string | undefined, delegationEnabled = false): string {
  const persona = delegationEnabled ? `${SYSTEM_PERSONA} ${DELEGATION_INSTRUCTION}` : SYSTEM_PERSONA;
  return memoryLines ? `${persona}\n\n${memoryLines}` : persona;
}

async function createLocalInputTranscriber(settings: RuntimeSettings, trace: (event: Record<string, unknown>) => void, onEvent: (event: Extract<VoiceEvent, { type: "speech.started" | "transcription.final" | "voice.error" }>) => void): Promise<RealtimeInputTranscriber | undefined> {
  const inputSettings = settings.inputTranscription ?? { enabled: false, language: "cs" };
  if (!inputSettings.enabled || settings.mode !== "native_realtime" || process.platform !== "win32") return undefined;
  const runtimeDirs = [
    resolve(process.cwd(), "speech-system", "scribe core", "runtime"),
    resolve(process.cwd(), "..", "speech-system", "scribe core", "runtime"),
  ];
  const configuredCli = inputSettings.cliPath ?? process.env.VOICE_STT_CLI;
  const configuredModel = inputSettings.modelPath ?? process.env.VOICE_STT_MODEL;
  let cliPath = configuredCli ?? resolve(runtimeDirs[0]!, "Release", "whisper-cli.exe");
  let modelPath = configuredModel ?? resolve(runtimeDirs[0]!, "ggml-small.bin");
  if (!configuredCli && !configuredModel) {
    for (const runtimeDir of runtimeDirs) {
      const candidateCli = resolve(runtimeDir, "Release", "whisper-cli.exe");
      const candidateModel = resolve(runtimeDir, "ggml-small.bin");
      try { await access(candidateCli); await access(candidateModel); cliPath = candidateCli; modelPath = candidateModel; break; } catch { /* try the next workspace layout */ }
    }
  }
  try {
    await access(cliPath);
    await access(modelPath);
  } catch {
    trace({ type: "realtime.input_transcription.unavailable", timestampMs: Date.now(), provider: "whisper", cliPath, modelPath });
    return undefined;
  }
  const language = process.env.VOICE_STT_LANGUAGE?.trim() || inputSettings.language;
  trace({ type: "realtime.input_transcription.ready", timestampMs: Date.now(), provider: "whisper", language, cliPath, modelPath });
  return new RealtimeInputTranscriber({
    stt: new WhisperCliProvider({ cliPath, modelPath, ...(inputSettings.threads === undefined ? {} : { threads: inputSettings.threads }) }),
    language,
    vad: new EnergyVad({ threshold: 0.02, endSilenceMs: 240, speechHoldMs: 80 }),
    segmenter: new UtteranceSegmenter({ minSpeechMs: 160, maxUtteranceMs: 20_000, preRollFrames: 8, continuationMs: 120 }),
    onEvent,
  });
}

export async function createAssistantRuntime(settings: RuntimeSettings, trace: (event: Record<string, unknown>) => void = () => {}, options: AssistantCompositionOptions = {}): Promise<AssistantComposition> {
  const platform = options.platform ?? createPlatformServices();
  const platformAvailable = platform.capability.status !== "unsupported";
  const platformReason = platform.capability.reason ?? `Platform '${platform.id}' has no adapter.`;
  if (!platformAvailable) trace({ type: "platform.unsupported", platform: platform.id, reason: platformReason });
  const state = settings.state.enabled ? new StateRuntime() : undefined;
  const memory = settings.memory.enabled ? new MemoryRuntime({ store: new SqliteMemoryStore({ path: settings.memory.path }) }) : undefined;
  const episodes = memory ? new EpisodeRuntime({ store: new SqliteEpisodeStore({ path: settings.memory.path }) }) : undefined;
  const extraction = memory ? new MemoryExtractionOrchestrator(memory, new DeterministicMemoryExtractor(), trace) : undefined;
  const episodeMemory = episodes ? new EpisodeMemoryWriter({ episodes, subjectId: settings.memory.scopeSubjectId, extractor: extraction, trace }) : undefined;
  if (memory) await mkdir(dirname(settings.memory.path), { recursive: true });

  const clap = new DoubleClapProvider({ id: "double-clap", minimumIntervalMs: settings.activation.minimumIntervalMs, maximumIntervalMs: settings.activation.maximumIntervalMs, amplitudeThreshold: settings.activation.amplitudeThreshold });
  const activationCore = new ActivationRuntime({ providers: [clap] });
  const activation = new ActivationCoreAdapter(activationCore, (event) => trace({ type: "activation.detected", ...event }));
  let announceShutdown: (request: { reason: string }) => void = () => undefined;
  const shutdownRequested = new Promise<{ reason: string }>((resolve) => { announceShutdown = resolve; });
  // Delegation needs memory: without it the delegated model has nothing to look up, and
  // an enabled-but-blind delegation would answer worse than not delegating at all.
  let activeSessionId: string | undefined;
  // Settings can arrive from a hand-built object, not only from loadRuntimeSettings.
  // A missing block means "off", never a crash on startup.
  const delegationSettings: DelegationSettings = settings.delegation ?? { enabled: false, provider: "gemini", model: "", fallbackModels: [], deadlineMs: 45_000, maximumModelCalls: 6, maximumToolCalls: 12, cancelOnSessionClose: true, defaultDelivery: "when_idle", lateResultPolicy: "queue" };
  const usageSettings: UsageSettings = settings.usage ?? { enabled: false, path: "", maxRecords: 10_000, unknownCostPolicy: "block", priceCatalogVersion: "unset" };
  const delegation = delegationSettings.enabled && memory
    ? createDelegation({
        delegation: delegationSettings,
        usage: usageSettings,
        memory,
        subjectId: settings.memory.scopeSubjectId,
        correlation: () => (activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(usageSettings.priceCatalog ? { priceCatalog: usageSettings.priceCatalog } : {}),
        trace,
      })
    : undefined;
  if (delegationSettings.enabled && !memory) trace({ type: "delegation.disabled", reason: "memory is required for delegated recall" });

  const tools = options.realtimeToolExecutor
    ? undefined
    : createDefaultToolRuntime(trace, delegation ? (registry) => registerVoiceDelegationTool(registry, delegation, {
        delegation: delegationSettings,
        usage: usageSettings,
        memory: memory!,
        subjectId: settings.memory.scopeSubjectId,
        correlation: () => (activeSessionId ? { sessionId: activeSessionId } : {}),
      }) : undefined);
  const realtimeToolExecutor = options.realtimeToolExecutor ?? (tools
    ? new ToolSystemRealtimeToolExecutor(tools, (request) => {
        if (request.action !== "shutdown") return;
        trace({ type: "runtime.shutdown.requested", tool: request.tool, reason: request.reason });
        announceShutdown({ reason: request.reason });
      })
    : undefined);
  const echo = createEchoGuard(settings.echoCancellation, settings.realtime.inputSampleRate, settings.realtime.outputSampleRate, trace);
  const localInputEvents = (event: Extract<VoiceEvent, { type: "speech.started" | "transcription.final" | "voice.error" }>) => {
    if (event.type === "speech.started") {
      trace({ type: "realtime.input.speech_started", timestampMs: Date.now(), sessionId: event.sessionId, transcriptionProvider: "whisper" });
      return;
    }
    if (event.type === "transcription.final") {
      const transcript = { type: "transcript.final" as const, sessionId: event.sessionId, text: event.text, source: "input" as const, timestampMs: event.endedAtMs };
      trace({ type: "realtime.transcript.final", timestampMs: transcript.timestampMs, sessionId: transcript.sessionId, text: transcript.text, source: transcript.source, transcriptionProvider: "whisper", language: event.language, recognitionLatencyMs: event.recognitionLatencyMs });
      void episodeMemory?.handle(transcript);
      void statePublisher(state, trace)?.set({ key: "speech.input", value: "idle", source: { sourceType: "system", sourceId: settings.assistantId } });
      return;
    }
    trace({ type: "realtime.input_transcription.failed", timestampMs: Date.now(), sessionId: event.sessionId, code: event.code, message: event.message, transcriptionProvider: "whisper" });
  };
  const inputTranscriber = await createLocalInputTranscriber(settings, trace, localInputEvents);
  let inputTranscriptionSessionId: string | undefined;
  const stopInputTranscription = (sessionId: string) => {
    if (inputTranscriptionSessionId !== sessionId) return;
    inputTranscriptionSessionId = undefined;
    void inputTranscriber?.stop();
  };
  const onInputFrame = inputTranscriber ? (frame: import("realtime-core").AudioFrame, sessionId: string) => {
    if (inputTranscriptionSessionId !== sessionId) {
      if (inputTranscriptionSessionId) void inputTranscriber.stop();
      inputTranscriptionSessionId = sessionId;
      try { inputTranscriber.startSession(sessionId); } catch (error) { trace({ type: "realtime.input_transcription.start_failed", timestampMs: Date.now(), sessionId, message: redact(error) }); return; }
    }
    void inputTranscriber.push(frame).catch((error) => trace({ type: "realtime.input_transcription.frame_failed", timestampMs: Date.now(), sessionId, message: redact(error) }));
  } : undefined;
  const realtimeCore = new RealtimeCore(new GeminiLiveProvider());
  const realtime = new RealtimeCoreAdapter(realtimeCore, async () => ({ provider: settings.realtime.provider, model: settings.realtime.model, ...(settings.realtime.voice ? { voice: settings.realtime.voice } : {}), inputFormat: { ...REALTIME_INPUT_FORMAT }, inputTranscription: inputTranscriber ? false : undefined, systemInstruction: systemInstruction(await memoryInstruction(memory, settings.memory.scopeSubjectId, settings.memory.retrievalLimit, settings.memory.retrievalTokenBudget), delegation !== undefined) }), (event) => {
    trace(event);
    const type = String(event.type);
    const publisher = statePublisher(state, trace);
    if (type === "realtime.input.speech_started") void publisher?.set({ key: "speech.input", value: "speaking", source: { sourceType: "system", sourceId: settings.assistantId } });
    if (type === "realtime.transcript.final" && event.source === "input") void publisher?.set({ key: "speech.input", value: "idle", source: { sourceType: "system", sourceId: settings.assistantId } });
    if (type === "realtime.output.audio_started") void publisher?.set({ key: "speech.output", value: "speaking", source: { sourceType: "system", sourceId: settings.assistantId } });
    if (type === "realtime.output.audio_completed" || type === "realtime.output.interrupted") void publisher?.set({ key: "speech.output", value: "idle", source: { sourceType: "system", sourceId: settings.assistantId } });
  }, (event) => void episodeMemory?.handle(event), realtimeToolExecutor, platform.player, echo, onInputFrame, stopInputTranscription);

  if (delegation) {
    // Rebind rather than bind: a reconnect must drain results that finished while the
    // previous transport was gone, otherwise the user is left silently without an answer.
    realtime.onSession((session, capabilities) => {
      activeSessionId = session.id;
      const contextInjection = capabilities.providers[0]?.contextInjection ?? false;
      trace({ type: "delegation.session.bound", sessionId: session.id, contextInjection });
      void delegation.delivery.rebind({ sessionId: session.id, session, contextInjection });
    });
  }
  const modular = settings.mode === "modular" && platformAvailable ? new ModularSpeechDriver({ speech: platform.createSpeechStack(), memory, memorySubjectId: settings.memory.scopeSubjectId, memoryRetrieval: { limit: settings.memory.retrievalLimit, tokenBudget: settings.memory.retrievalTokenBudget }, trace }) : undefined;

  const microphone: ClapListener | undefined = platformAvailable
    ? platform.createActivationListener(clap, { sourceId: settings.activation.sourceId, device: settings.activation.device, onFrame: (frame) => { if (settings.mode === "native_realtime") void realtime.sendMicrophonePcm(frame); modular?.pushMicrophonePcm(frame); }, ...(options.microphoneFactory ? { microphoneFactory: options.microphoneFactory } : {}) })
    : undefined;
  const microphoneComponent: RuntimeComponent = microphone
    ? { id: "microphone", start: () => microphone.start(), stop: () => microphone.stop(), health: async (): Promise<ComponentHealth> => ({ state: microphone.isRunning() ? "healthy" : "unhealthy" }), capabilities: async () => ({ pcmInput: true, rawAudioPersistence: false, platform: platform.id }) }
    : unavailableComponent("microphone", platformReason, { pcmInput: false, platform: platform.id });
  const playbackComponent: RuntimeComponent = platformAvailable
    ? { id: "playback", start: async () => undefined, stop: async () => undefined, health: async () => ({ state: "healthy" as const }), capabilities: async () => ({ executable: platform.player.executable, sampleRate: settings.realtime.outputSampleRate, platform: platform.id }) }
    : unavailableComponent("playback", platformReason, { platform: platform.id });
  const components: RuntimeComponent[] = [
    ...(tools ? [toolComponent(tools)] : []),
    ...(delegation ? [{
      id: "delegation",
      start: () => delegation.start(),
      stop: () => delegation.stop(),
      health: async (): Promise<ComponentHealth> => ({ state: "healthy" as const }),
      capabilities: async () => ({
        provider: delegationSettings.provider,
        model: delegationSettings.model,
        fallbackModels: delegationSettings.fallbackModels,
        delivery: delegationSettings.defaultDelivery,
        lateResultPolicy: delegationSettings.lateResultPolicy,
        delegatedTools: delegation.delegatedTools.discover().map((declaration: { name: string }) => declaration.name),
      }),
    }] : []),
    ...(memory ? [{
      id: "memory",
      start: async () => { await memory.start(); await episodes?.start(); },
      stop: async () => { await episodeMemory?.flush(); await episodes?.stop(); await memory.stop(); },
      health: () => memory.health(),
      capabilities: async () => ({ ...(await memory.capabilities()) }),
    }] : []),
    ...(state ? [asDiagnosticComponent("state", state)] : []),
    ...(settings.mode === "modular"
      ? [modular ? asDiagnosticComponent("modular", modular) : unavailableComponent("modular", platformReason, { platform: platform.id })]
      : [{ id: "realtime", start: async () => undefined, stop: async () => realtime.stop(), health: () => realtime.health(), capabilities: () => realtime.capabilities() }]),
    playbackComponent,
    activation,
    microphoneComponent,
  ];
  const publisher = statePublisher(state, trace);
  const runtime = new AssistantRuntime({ assistantId: settings.assistantId, mode: settings.mode, inactivityMs: settings.inactivityMs, state: publisher }, { components, activation, nativeRealtime: settings.mode === "native_realtime" ? realtime : undefined, modular });
  return { runtime, memory, state, tools, components, platform, shutdownRequested };
}
