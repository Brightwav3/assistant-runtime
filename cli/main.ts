import { AssistantRuntime } from "../src/runtime.js";
import { ActivationCoreAdapter, RealtimeCoreAdapter } from "../src/adapters.js";
import { ActivationRuntime, DoubleClapProvider, WindowsClapListener } from "activation-core";
import { FakeRealtimeSpeechProvider, RealtimeCore } from "realtime-core";
const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const command = process.argv[2];
const clap = new DoubleClapProvider();
const activationCore = new ActivationRuntime({ providers: [clap] });
const activation = new ActivationCoreAdapter(activationCore);
const listener = new WindowsClapListener(clap, { sourceId: "windows-default-microphone", ...(process.env.CLAP_DEBUG === "1" ? { onPeak: (peak: number) => json({ type: "activation.audio.peak", peak }) } : {}) });
const realtime = new RealtimeCoreAdapter(new RealtimeCore(new FakeRealtimeSpeechProvider()), { provider: "fake", inputFormat: { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } });
const microphone = { id: "windows-clap-listener", async start() { await listener.start(); }, async stop() { await listener.stop(); }, async health() { return { state: listener.isRunning() ? "healthy" as const : "unhealthy" as const }; } };
const runtime = new AssistantRuntime({ assistantId: process.env.ASSISTANT_ID ?? "assistant.primary", mode: "native_realtime", inactivityMs: Number(process.env.INACTIVITY_MS ?? 30000) }, { components: [activation, microphone], activation, nativeRealtime: realtime });
if (command === "health") json(await runtime.health());
else if (command === "capabilities") json(runtime.capabilities());
else if (command === "status") json(runtime.status());
else if (command === "start") { await runtime.start(); json(runtime.status()); const keepAlive = setInterval(() => {}, 1 << 30); await new Promise<void>((resolve) => { const stop = () => { clearInterval(keepAlive); void runtime.stop().finally(resolve); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); }); }
else { json({ error: { code: "COMMAND_INVALID", message: "Use start, health, capabilities, or status." } }); process.exitCode = 2; }
