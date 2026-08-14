import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface RuntimeSettings {
  assistantId: string;
  mode: "native_realtime" | "modular";
  inactivityMs: number;
  activation: { provider: "double_clap"; sourceId: string; device?: string; minimumIntervalMs: number; maximumIntervalMs: number; amplitudeThreshold: number };
  realtime: { provider: "gemini"; model?: string; voice?: string; inputSampleRate: number; outputSampleRate: number };
  memory: { enabled: boolean; path: string; scopeSubjectId: string; retrievalLimit?: number; retrievalTokenBudget?: number; episodeRetentionDays?: number };
  state: { enabled: boolean };
  echoCancellation: EchoCancellationSettings;
}

export interface EchoCancellationSettings {
  enabled: boolean;
  /**
   * `adaptive` keeps full duplex and may degrade as the capture and playback clocks drift
   * apart; `gate` is certain but costs the ability to interrupt by voice; `auto` runs the
   * adaptive filter and falls back to the gate when it reports it is not cancelling.
   */
  processor: "adaptive" | "gate" | "auto";
  /** Suppression tail after playback stops, covering output latency. Bluetooth runs 150-300 ms. */
  tailMs: number;
  /**
   * Upper bound of the delay search, in ms. It must cover the whole path from handing a
   * chunk to the player to hearing it back: the player's own buffering plus the output
   * latency. AEC System defaults to 500 ms for the acoustic path alone, which is not enough
   * once `ffplay` and a Bluetooth speaker are both in the way — and a delay outside the
   * window means the filter never converges and the gate never lets go.
   */
  maxDelayMs: number;
  /**
   * Gain applied to capture while the gate is suppressing. 0 is silence, which is certain but
   * costs voice barge-in entirely: the provider cannot hear an interruption it is never sent.
   * A small value keeps the ratio between the user and the echo and moves both down, which
   * restores barge-in when near-end speech is louder at the microphone than the echo is —
   * measured on this hardware, echo sits at a median peak of 105 against 3000-5000 for speech.
   */
  suppressionGain: number;
  /**
   * Peak capture level, 0..1, at which suppression is lifted because the sound is too loud
   * to be echo.
   *
   * A gate that never lifts removes voice barge-in entirely: the provider cannot react to an
   * interruption it is never sent. Measured on this hardware, echo returns at a median frame
   * peak of 105 of 32768 while near-end speech reaches 3000-5000, so a threshold between
   * them separates the two without any cancellation at all. Set to 0 to disable and keep the
   * gate absolute.
   */
  bargeInThreshold: number;
  /** How long capture keeps flowing after a barge-in, so a sentence is not chopped into frames. */
  bargeInHoldMs: number;
  /** Echo return loss enhancement, in dB, below which `auto` stops trusting the adaptive filter. */
  minErleDb: number;
  /** Consecutive healthy frames required before `auto` returns to the adaptive filter. */
  recoveryFrames: number;
  /**
   * Where to write the played, captured, and cleaned streams for offline analysis. Off by
   * default: it records the user's microphone to disk, which is not a default worth taking.
   */
  recordDir?: string;
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
  realtime: { provider: "gemini", model: "gemini-3.1-flash-live-preview", voice: "Charon", inputSampleRate: 16_000, outputSampleRate: 24_000 },
  memory: { enabled: true, path: "..\\.runtime\\memory.sqlite", scopeSubjectId: "primary-user", retrievalLimit: 8, retrievalTokenBudget: 1200, episodeRetentionDays: 30 },
  state: { enabled: true },
  echoCancellation: { enabled: true, processor: "auto", tailMs: 400, maxDelayMs: 1_000, suppressionGain: 0, bargeInThreshold: 0.06, bargeInHoldMs: 800, minErleDb: 6, recoveryFrames: 25 },
};

function merge(raw: Partial<RuntimeSettings>, basePath: string): RuntimeSettings {
  const settings: RuntimeSettings = {
    ...defaults,
    ...raw,
    activation: { ...defaults.activation, ...(raw.activation ?? {}) },
    realtime: { ...defaults.realtime, ...(raw.realtime ?? {}) },
    memory: { ...defaults.memory, ...(raw.memory ?? {}) },
    state: { ...defaults.state, ...(raw.state ?? {}) },
    echoCancellation: { ...defaults.echoCancellation, ...(raw.echoCancellation ?? {}) },
  };
  if (!settings.assistantId || !Number.isFinite(settings.inactivityMs) || settings.inactivityMs < 1) throw new Error("assistantId and a positive inactivityMs are required.");
  if (settings.mode !== "native_realtime" && settings.mode !== "modular") throw new Error("mode must be native_realtime or modular.");
  if (settings.memory.enabled && !settings.memory.path) throw new Error("memory.path is required when memory is enabled.");
  if (settings.memory.enabled && !isAbsolute(settings.memory.path)) settings.memory.path = resolve(basePath, settings.memory.path);
  const echo = settings.echoCancellation;
  if (echo.processor !== "adaptive" && echo.processor !== "gate" && echo.processor !== "auto") throw new Error("echoCancellation.processor must be adaptive, gate, or auto.");
  if (!Number.isFinite(echo.tailMs) || echo.tailMs < 0) throw new Error("echoCancellation.tailMs must be zero or more.");
  if (!Number.isFinite(echo.maxDelayMs) || echo.maxDelayMs <= 0) throw new Error("echoCancellation.maxDelayMs must be greater than zero.");
  if (!(echo.suppressionGain >= 0 && echo.suppressionGain <= 1)) throw new Error("echoCancellation.suppressionGain must be within [0, 1].");
  if (!(echo.bargeInThreshold >= 0 && echo.bargeInThreshold <= 1)) throw new Error("echoCancellation.bargeInThreshold must be within [0, 1].");
  if (!Number.isFinite(echo.bargeInHoldMs) || echo.bargeInHoldMs < 0) throw new Error("echoCancellation.bargeInHoldMs must be zero or more.");
  if (!Number.isFinite(echo.minErleDb)) throw new Error("echoCancellation.minErleDb must be a number.");
  if (!Number.isInteger(echo.recoveryFrames) || echo.recoveryFrames < 1) throw new Error("echoCancellation.recoveryFrames must be a positive integer.");
  if (echo.recordDir && !isAbsolute(echo.recordDir)) echo.recordDir = resolve(basePath, echo.recordDir);
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
