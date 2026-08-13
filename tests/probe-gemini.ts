// Manual probe: microphone-free check of connect -> greeting -> audio -> ffplay.
// Run: npx tsx tests/probe-gemini.ts   (requires GEMINI_API_KEY in the environment)
import { RealtimeCoreAdapter } from "../src/adapters.js";
import { loadDotEnv } from "../src/config.js";
import { GeminiLiveProvider, RealtimeCore } from "realtime-core";

const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
await loadDotEnv();
process.on("unhandledRejection", (error) => json({ type: "runtime.error", message: error instanceof Error ? error.message : String(error) }));

const adapter = new RealtimeCoreAdapter(new RealtimeCore(new GeminiLiveProvider()), { provider: "gemini", inputFormat: { sampleRate: 16_000, channels: 1, sampleFormat: "pcm_s16le", frameDurationMs: 20 } }, json);
const session = await adapter.open();
setTimeout(() => { json({ type: "probe.timeout" }); void session.close(); }, 20_000).unref?.();
await session.done;
json({ type: "probe.finished" });
process.exit(0);
