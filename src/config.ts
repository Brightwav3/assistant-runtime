import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface RuntimeSettings {
  assistantId: string;
  mode: "native_realtime" | "modular";
  inactivityMs: number;
  activation: { provider: "double_clap"; sourceId: string; device?: string; minimumIntervalMs: number; maximumIntervalMs: number; amplitudeThreshold: number };
  realtime: { provider: "gemini"; model?: string; inputSampleRate: number; outputSampleRate: number };
  memory: { enabled: boolean; path: string; scopeSubjectId: string };
  state: { enabled: boolean };
}

const defaults: RuntimeSettings = {
  assistantId: "assistant.primary",
  mode: "native_realtime",
  inactivityMs: 30_000,
  activation: { provider: "double_clap", sourceId: "windows-default-microphone", minimumIntervalMs: 150, maximumIntervalMs: 700, amplitudeThreshold: 0.18 },
  realtime: { provider: "gemini", model: "gemini-3.1-flash-live-preview", inputSampleRate: 16_000, outputSampleRate: 24_000 },
  memory: { enabled: true, path: "..\\.runtime\\memory.sqlite", scopeSubjectId: "primary-user" },
  state: { enabled: true },
};

function merge(raw: Partial<RuntimeSettings>, basePath: string): RuntimeSettings {
  const settings: RuntimeSettings = {
    ...defaults,
    ...raw,
    activation: { ...defaults.activation, ...(raw.activation ?? {}) },
    realtime: { ...defaults.realtime, ...(raw.realtime ?? {}) },
    memory: { ...defaults.memory, ...(raw.memory ?? {}) },
    state: { ...defaults.state, ...(raw.state ?? {}) },
  };
  if (!settings.assistantId || !Number.isFinite(settings.inactivityMs) || settings.inactivityMs < 1) throw new Error("assistantId and a positive inactivityMs are required.");
  if (settings.mode !== "native_realtime" && settings.mode !== "modular") throw new Error("mode must be native_realtime or modular.");
  if (settings.memory.enabled && !settings.memory.path) throw new Error("memory.path is required when memory is enabled.");
  if (settings.memory.enabled && !isAbsolute(settings.memory.path)) settings.memory.path = resolve(basePath, settings.memory.path);
  return settings;
}

export async function loadRuntimeSettings(configPath = process.env.JARVIS_CONFIG ?? resolve(process.cwd(), "config.json")): Promise<RuntimeSettings> {
  try {
    await access(configPath);
  } catch {
    return merge({}, process.cwd());
  }
  const raw = JSON.parse(await readFile(configPath, "utf8")) as Partial<RuntimeSettings>;
  return merge(raw, resolve(configPath, ".."));
}
