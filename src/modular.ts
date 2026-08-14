import { EnergyVad, ProviderRegistry, UtteranceSegmenter, VoicePipeline, VoiceSession, type AudioFrame, type AudioInput, type VoiceEvent } from "scribe-core";
import { IntelligenceRuntime } from "intelligence-core";
import type { MemoryRuntime } from "memory-core";
import type { ModularDriver } from "./contracts.js";
import type { PlatformSpeechStack } from "./platform/contracts.js";

class PcmFrameInput implements AudioInput {
  private running = false;
  private framesQueue: AudioFrame[] = [];
  private waiter?: () => void;
  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; this.waiter?.(); this.waiter = undefined; }
  push(frame: AudioFrame): void { if (!this.running) return; this.framesQueue.push(frame); this.waiter?.(); this.waiter = undefined; }
  async *frames(): AsyncIterable<AudioFrame> {
    while (this.running || this.framesQueue.length) {
      const frame = this.framesQueue.shift();
      if (frame) { yield frame; continue; }
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  }
}

export class ModularSpeechDriver implements ModularDriver {
  private readonly intelligence = new IntelligenceRuntime();
  private readonly input = new PcmFrameInput();
  private readonly speech: PlatformSpeechStack;
  private readonly registry: ProviderRegistry;
  private readonly output: PlatformSpeechStack["output"];
  private readonly trace: (event: Record<string, unknown>) => void;
  private readonly memory?: MemoryRuntime;
  private readonly memorySubjectId?: string;
  private readonly memoryRetrieval?: { limit?: number; tokenBudget?: number };
  private latestText = "";
  private onActivity?: () => void;

  constructor(options: { speech: PlatformSpeechStack; memory?: MemoryRuntime; memorySubjectId?: string; memoryRetrieval?: { limit?: number; tokenBudget?: number }; trace?: (event: Record<string, unknown>) => void }) {
    this.speech = options.speech;
    this.registry = new ProviderRegistry({ stt: options.speech.stt, tts: options.speech.tts, vadAvailable: true });
    this.output = options.speech.output;
    this.memory = options.memory;
    this.memorySubjectId = options.memorySubjectId;
    this.memoryRetrieval = options.memoryRetrieval;
    this.trace = options.trace ?? (() => {});
  }
  async start(): Promise<void> { await this.intelligence.start(); }
  async stop(): Promise<void> { await this.input.stop(); await this.intelligence.stop(); }
  async health(): Promise<{ state: "healthy" | "degraded" | "unhealthy"; detail?: string }> { const health = this.intelligence.health(); return { state: health.state, detail: health.state === "healthy" ? undefined : "Modular Intelligence runtime is not running." }; }
  async capabilities(): Promise<Record<string, unknown>> { return { stt: this.speech.descriptor.stt, tts: this.speech.descriptor.tts, localOutput: true, memoryContext: Boolean(this.memory) }; }
  async run(input: { interactionId: string; signal: AbortSignal; onActivity?: () => void }): Promise<void> {
    this.onActivity = input.onActivity;
    const session = new VoiceSession({ stt: this.registry.stt, tts: this.registry.tts, output: this.output, language: "en-US" });
    const off = session.onEvent((event: VoiceEvent) => { this.trace({ type: `modular.${event.type}`, ...("text" in event ? { text: event.text } : {}) }); if (event.type === "response.requested") void this.respond(session, input.interactionId, event.utteranceId); });
    const capture = session.onEvent((event: VoiceEvent) => { if (event.type === "transcription.final") this.latestText = event.text; });
    await session.start();
    const pipeline = new VoicePipeline({ input: this.input, vad: new EnergyVad({ threshold: 0.02, endSilenceMs: 700 }), segmenter: new UtteranceSegmenter({ minSpeechMs: 250, maxUtteranceMs: 15_000, preRollFrames: 2 }), session });
    const stopInput = () => { void this.input.stop(); };
    input.signal.addEventListener("abort", stopInput, { once: true });
    try { await pipeline.run(input.signal); } finally { input.signal.removeEventListener("abort", stopInput); off(); capture(); this.onActivity = undefined; }
  }
  pushMicrophonePcm(data: Int16Array): void { if (data.some((sample) => Math.abs(sample) / 32768 >= 0.02)) this.onActivity?.(); this.input.push({ streamId: "local-default-microphone", timestampMs: Date.now(), format: { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 100 }, data: data.slice() }); }
  private async respond(session: VoiceSession, interactionId: string, utteranceId: string): Promise<void> {
    try {
      const result = await this.intelligence.execute({ request_id: utteranceId, session_id: interactionId, input: { type: "text", text: this.latestText }, ...(this.memory ? { memory_context: { subject_id: this.memorySubjectId ?? interactionId, ...(this.memoryRetrieval?.limit !== undefined ? { limit: this.memoryRetrieval.limit } : {}), ...(this.memoryRetrieval?.tokenBudget !== undefined ? { token_budget: this.memoryRetrieval.tokenBudget } : {}) } } : {}) });
      const text = result.outputs.find((output): output is { type: "text"; text: string } => output.type === "text")?.text;
      if (text) await session.submitResponse({ text, language: "en-US" });
    } catch (error) { this.trace({ type: "modular.error", message: error instanceof Error ? error.message : String(error) }); }
  }
}
