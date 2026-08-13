/**
 * Manual-only native realtime tool probe.
 * Run from assistant-runtime with GEMINI_API_KEY in the current process.
 * This file is intentionally not imported by production composition.
 */

import { spawn } from "node:child_process";
import { createAssistantRuntime } from "../src/composition.js";
import { loadDotEnv, loadRuntimeSettings } from "../src/config.js";
import { ToolSystemRealtimeToolExecutor } from "../src/tool-bridge.js";
import { AllowlistPolicy, AllowlistProcessBroker, ToolRegistry, ToolRuntime, openAppDeclaration, openAppHandler } from "tool-system";

const writeTrace = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

await loadDotEnv();

if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY must be set in the current process environment.");

const catalog = { calculator: "calc.exe" } as const;
const registry = new ToolRegistry();
registry.register(openAppDeclaration(catalog), openAppHandler(catalog));
const processBroker = new AllowlistProcessBroker({
  executables: ["calc.exe"],
  spawn: (launch) => new Promise<void>((resolve, reject) => {
    const child = spawn(launch.executable, [...launch.args], { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  }),
});
const toolRuntime = new ToolRuntime({ registry, policy: new AllowlistPolicy({ allow: ["open_app"] }), services: { process: processBroker } });
await toolRuntime.start();

const loaded = await loadRuntimeSettings();
const settings = { ...loaded, mode: "native_realtime" as const };
const composition = await createAssistantRuntime(settings, writeTrace, { realtimeToolExecutor: new ToolSystemRealtimeToolExecutor(toolRuntime) });

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await composition.runtime.stop();
  await toolRuntime.stop();
};
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
process.on("unhandledRejection", (error) => writeTrace({ type: "probe.unhandled_rejection", message: error instanceof Error ? error.message : String(error) }));

writeTrace({ type: "probe.ready", tool: "open_app", catalog: ["calculator"], instruction: "Double-clap, then say Open Calculator." });
await composition.runtime.start();
await new Promise<void>(() => undefined);
