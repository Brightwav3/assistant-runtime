import { AssistantRuntime } from "../src/runtime.js";
const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const command = process.argv[2];
const runtime = new AssistantRuntime({ assistantId: process.env.ASSISTANT_ID ?? "assistant.primary", mode: (process.env.INTERACTION_MODE as "native_realtime" | "modular") ?? "native_realtime", inactivityMs: Number(process.env.INACTIVITY_MS ?? 30000) }, { components: [] });
if (command === "health") json(await runtime.health());
else if (command === "capabilities") json(runtime.capabilities());
else if (command === "status") json(runtime.status());
else if (command === "start") { await runtime.start(); json(runtime.status()); await new Promise<void>((resolve) => { const stop = () => { void runtime.stop().finally(resolve); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); }); }
else { json({ error: { code: "COMMAND_INVALID", message: "Use start, health, capabilities, or status." } }); process.exitCode = 2; }
