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

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    const quote = trimmed[0];
    const unquoted = trimmed.slice(1, -1);
    return quote === '"' ? unquoted.replaceAll("\\n", "\n").replaceAll('\\"', '"').replaceAll("\\\\", "\\") : unquoted;
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

/** Loads simple KEY=value entries without replacing explicitly supplied process variables. */
export async function loadDotEnv(filePath = resolve(process.cwd(), ".env")): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  for (const line of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    const value = parseEnvValue(rawValue);
    if (!value) continue;
    if (process.env[name] === undefined || process.env[name] === "") process.env[name] = value;
  }
}

const defaults: RuntimeSettings = {
  assistantId: "assistant.primary",
  mode: "native_realtime",
  inactivityMs: 30_000,
  activation: { provider: "double_clap", sourceId: "local-default-microphone", minimumIntervalMs: 150, maximumIntervalMs: 700, amplitudeThreshold: 0.18 },
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

/**
 * Configuration path precedence, in order:
 * 1. an explicit argument to `loadRuntimeSettings`;
 * 2. `ASSISTANT_CONFIG`;
 * 3. `JARVIS_CONFIG` (deprecated, retained for compatibility);
 * 4. `config.json` in the working directory.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const primary = env.ASSISTANT_CONFIG?.trim();
  if (primary) return primary;
  const legacy = env.JARVIS_CONFIG?.trim();
  if (legacy) return legacy;
  return resolve(cwd, "config.json");
}

export async function loadRuntimeSettings(configPath = resolveConfigPath()): Promise<RuntimeSettings> {
  await loadDotEnv(resolve(configPath, "..", ".env"));
  try {
    await access(configPath);
  } catch {
    return merge({}, process.cwd());
  }
  const raw = JSON.parse(await readFile(configPath, "utf8")) as Partial<RuntimeSettings>;
  return merge(raw, resolve(configPath, ".."));
}
