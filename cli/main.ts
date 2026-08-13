import { AssistantRuntimeError } from "../src/contracts.js";
import { createAssistantRuntime } from "../src/composition.js";
import { loadRuntimeSettings } from "../src/config.js";
import { createHumanTrace } from "../src/console-log.js";
import { PCM_PLAYER, verifyPlayback } from "../src/adapters.js";
import { memoryKinds, type CreateMemoryInput, type MemoryKind } from "memory-core";

const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const args = process.argv.slice(3);
let humanStart = false;
const flag = (name: string): string | undefined => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function memoryCommand(): Promise<void> {
  const settings = await loadRuntimeSettings();
  const composition = await createAssistantRuntime(settings);
  if (!composition.memory) throw new Error("Memory is disabled in the runtime configuration.");
  await composition.memory.start();
  try {
    const operation = process.argv[3] ?? "list";
    if (operation === "list") json(await composition.memory.list());
    else if (operation === "search") json(await composition.memory.search({ query: flag("--query"), limit: Number(flag("--limit") ?? 50) }));
    else if (operation === "forget") { const id = flag("--id"); if (!id) throw new Error("memory forget requires --id=<memory-id>"); await composition.memory.forget(id); json({ ok: true, memoryId: id }); }
    else if (operation === "add") {
      const text = flag("--text"); const kind = (flag("--kind") ?? "fact") as MemoryKind;
      if (!text) throw new Error("memory add requires --text=<durable-fact>");
      if (!memoryKinds.includes(kind)) throw new Error(`memory add kind must be one of: ${memoryKinds.join(", ")}`);
      const input: CreateMemoryInput = { kind, content: { type: "text", text }, scope: { type: "user", subjectId: settings.memory.scopeSubjectId }, provenance: { sourceType: "user", sourceId: "cli" }, confidence: 1, tags: ["explicit"] };
      json(await composition.memory.create(input));
    } else throw new Error("Use memory list, memory search, memory add, or memory forget.");
  } finally { await composition.memory.stop(); }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  humanStart = command === "start" && !args.includes("--json");
  if (command === "memory") return memoryCommand();
  const settings = await loadRuntimeSettings();
  const trace = humanStart ? createHumanTrace() : (event: Record<string, unknown>) => json(event);
  const composition = await createAssistantRuntime(settings, trace);
  const runtime = composition.runtime;
  if (command === "health") json(await runtime.health());
  else if (command === "capabilities") json({ ...runtime.capabilities(), components: await runtime.componentCapabilities(), player: { executable: PCM_PLAYER.executable, sampleRate: settings.realtime.outputSampleRate } });
  else if (command === "status") json(runtime.status());
  else if (command === "start") {
    const playback = await verifyPlayback(settings.realtime.outputSampleRate);
    trace({ type: "playback.preflight", ...playback });
    if (!playback.ok) throw new Error(playback.message);
    await runtime.start();
    if (humanStart) trace({ type: "runtime.started" });
    else json(runtime.status());
    await new Promise<void>((resolve) => {
      let stopped = false;
      const stop = () => { if (stopped) return; stopped = true; void runtime.stop().finally(resolve); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
  } else {
    json({ error: { code: "COMMAND_INVALID", message: "Use start [--json], health, capabilities, status, or memory." } });
    process.exitCode = 2;
  }
}

void main().catch((error) => {
  const code = error instanceof AssistantRuntimeError ? error.code : "RUNTIME_ERROR";
  if (humanStart) {
    process.stderr.write(`CHYBA: ${message(error)}\n`);
    process.exitCode = 1;
    return;
  }
  json({ error: { code, message: message(error) } });
  process.exitCode = 1;
});
