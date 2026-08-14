import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface RuntimeSettings {
  assistantId: string;
  mode: "native_realtime" | "modular";
  inactivityMs: number;
  activation: { provider: "double_clap"; sourceId: string; device?: string; minimumIntervalMs: number; maximumIntervalMs: number; amplitudeThreshold: number };
  realtime: { provider: "gemini"; model?: string; voice?: string; inputSampleRate: number; outputSampleRate: number };
  inputTranscription: { enabled: boolean; language: string; cliPath?: string; modelPath?: string; threads?: number };
  memory: { enabled: boolean; path: string; scopeSubjectId: string; retrievalLimit?: number; retrievalTokenBudget?: number; episodeRetentionDays?: number };
  state: { enabled: boolean };
  echoCancellation: EchoCancellationSettings;
  delegation: DelegationSettings;
  usage: UsageSettings;
}

/**
 * The delegation model is configured independently of the voice model and is never
 * derived from it. They are two different jobs: one keeps a conversation alive, the
 * other reasons. Tying them together would mean a voice upgrade silently changes what
 * does the thinking.
 */
export interface DelegationSettings {
  enabled: boolean;
  provider: "gemini";
  model: string;
  /** Tried in this order. Deterministic on purpose: a random pick makes a failure irreproducible. */
  fallbackModels: string[];
  deadlineMs: number;
  maximumModelCalls: number;
  maximumToolCalls: number;
  cancelOnSessionClose: boolean;
  defaultDelivery: "interrupt" | "when_idle" | "silent";
  lateResultPolicy: "queue" | "drop" | "persist";
}

export interface UsageSettings {
  enabled: boolean;
  /** Append-only operational records. Runtime state, never committed. */
  path: string;
  maxRecords: number;
  /** What to do when the next call has no matching price. Fail-closed by default. */
  unknownCostPolicy: "allow" | "warn" | "block";
  priceCatalogVersion: string;
  maximumCost?: number;
}

export interface EchoCancellationSettings {
  enabled: boolean;
  /**
   * `adaptive` cancels and keeps full duplex, and degrades as the capture and playback
   * clocks drift apart; `gate` suppresses, which is certain and costs voice barge-in;
   * `cancel_or_suppress` uses the filter's output while it reports measurable cancellation
   * and the gate's when it does not.
   *
   * Named for what it does rather than "auto", because on hardware where the filter never
   * converges — a Bluetooth speaker, measured — this setting never cancels anything, and a
   * reader is entitled to know that from the name.
   */
  processor: "adaptive" | "gate" | "cancel_or_suppress";
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
   * How many times louder than the measured echo a sound must be before suppression lifts
   * for it. 0 disables barge-in and keeps the gate absolute.
   *
   * A gate that never lifts removes voice barge-in entirely: the provider cannot react to an
   * interruption it is never sent. The echo level is measured continuously from the capture
   * the gate is suppressing, rather than configured, because it is a property of the room,
   * the speaker, and the microphone gain — an absolute threshold tuned in one room is the
   * first thing that is wrong in the next one.
   */
  bargeInMargin: number;
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
  inputTranscription: { enabled: true, language: "cs" },
  memory: { enabled: true, path: "..\\.runtime\\memory.sqlite", scopeSubjectId: "primary-user", retrievalLimit: 8, retrievalTokenBudget: 1200, episodeRetentionDays: 30 },
  state: { enabled: true },
  echoCancellation: { enabled: true, processor: "cancel_or_suppress", tailMs: 400, maxDelayMs: 1_000, suppressionGain: 0, bargeInMargin: 2, bargeInHoldMs: 800, minErleDb: 6, recoveryFrames: 25 },
  delegation: {
    enabled: false,
    provider: "gemini",
    model: "gemini-2.5-flash",
    fallbackModels: [],
    deadlineMs: 45_000,
    maximumModelCalls: 6,
    maximumToolCalls: 12,
    cancelOnSessionClose: true,
    // The conversation is half duplex: cutting the assistant off mid-sentence to
    // announce a background finding is worse than waiting for the next gap.
    defaultDelivery: "when_idle",
    lateResultPolicy: "queue",
  },
  usage: { enabled: true, path: "..\\.runtime\\usage.jsonl", maxRecords: 10_000, unknownCostPolicy: "block", priceCatalogVersion: "unset" },
};

function merge(raw: Partial<RuntimeSettings>, basePath: string): RuntimeSettings {
  const settings: RuntimeSettings = {
    ...defaults,
    ...raw,
    activation: { ...defaults.activation, ...(raw.activation ?? {}) },
    realtime: { ...defaults.realtime, ...(raw.realtime ?? {}) },
    inputTranscription: { ...defaults.inputTranscription, ...(raw.inputTranscription ?? {}) },
    memory: { ...defaults.memory, ...(raw.memory ?? {}) },
    state: { ...defaults.state, ...(raw.state ?? {}) },
    echoCancellation: { ...defaults.echoCancellation, ...(raw.echoCancellation ?? {}) },
    delegation: { ...defaults.delegation, ...(raw.delegation ?? {}) },
    usage: { ...defaults.usage, ...(raw.usage ?? {}) },
  };
  if (!settings.assistantId || !Number.isFinite(settings.inactivityMs) || settings.inactivityMs < 1) throw new Error("assistantId and a positive inactivityMs are required.");
  if (settings.mode !== "native_realtime" && settings.mode !== "modular") throw new Error("mode must be native_realtime or modular.");
  if (settings.memory.enabled && !settings.memory.path) throw new Error("memory.path is required when memory is enabled.");
  if (settings.memory.enabled && !isAbsolute(settings.memory.path)) settings.memory.path = resolve(basePath, settings.memory.path);
  const echo = settings.echoCancellation;
  if (echo.processor !== "adaptive" && echo.processor !== "gate" && echo.processor !== "cancel_or_suppress") throw new Error("echoCancellation.processor must be adaptive, gate, or cancel_or_suppress.");
  if (!Number.isFinite(echo.tailMs) || echo.tailMs < 0) throw new Error("echoCancellation.tailMs must be zero or more.");
  if (!Number.isFinite(echo.maxDelayMs) || echo.maxDelayMs <= 0) throw new Error("echoCancellation.maxDelayMs must be greater than zero.");
  if (!(echo.suppressionGain >= 0 && echo.suppressionGain <= 1)) throw new Error("echoCancellation.suppressionGain must be within [0, 1].");
  if (!Number.isFinite(echo.bargeInMargin) || echo.bargeInMargin < 0) throw new Error("echoCancellation.bargeInMargin must be zero or more.");
  if (!Number.isFinite(echo.bargeInHoldMs) || echo.bargeInHoldMs < 0) throw new Error("echoCancellation.bargeInHoldMs must be zero or more.");
  if (!Number.isFinite(echo.minErleDb)) throw new Error("echoCancellation.minErleDb must be a number.");
  if (!Number.isInteger(echo.recoveryFrames) || echo.recoveryFrames < 1) throw new Error("echoCancellation.recoveryFrames must be a positive integer.");
  if (echo.recordDir && !isAbsolute(echo.recordDir)) echo.recordDir = resolve(basePath, echo.recordDir);

  const delegation = settings.delegation;
  if (delegation.provider !== "gemini") throw new Error("delegation.provider must be gemini.");
  if (delegation.enabled && !delegation.model.trim()) throw new Error("delegation.model is required when delegation is enabled.");
  if (!Array.isArray(delegation.fallbackModels) || delegation.fallbackModels.some((model) => typeof model !== "string" || !model.trim())) {
    throw new Error("delegation.fallbackModels must be an ordered list of model names.");
  }
  if (delegation.fallbackModels.includes(delegation.model)) throw new Error("delegation.fallbackModels must not repeat delegation.model.");
  if (!Number.isFinite(delegation.deadlineMs) || delegation.deadlineMs <= 0) throw new Error("delegation.deadlineMs must be greater than zero.");
  if (!Number.isInteger(delegation.maximumModelCalls) || delegation.maximumModelCalls < 1) throw new Error("delegation.maximumModelCalls must be a positive integer.");
  if (!Number.isInteger(delegation.maximumToolCalls) || delegation.maximumToolCalls < 1) throw new Error("delegation.maximumToolCalls must be a positive integer.");
  if (!["interrupt", "when_idle", "silent"].includes(delegation.defaultDelivery)) throw new Error("delegation.defaultDelivery must be interrupt, when_idle, or silent.");
  if (!["queue", "drop", "persist"].includes(delegation.lateResultPolicy)) throw new Error("delegation.lateResultPolicy must be queue, drop, or persist.");

  const usage = settings.usage;
  if (!["allow", "warn", "block"].includes(usage.unknownCostPolicy)) throw new Error("usage.unknownCostPolicy must be allow, warn, or block.");
  if (!Number.isInteger(usage.maxRecords) || usage.maxRecords < 1) throw new Error("usage.maxRecords must be a positive integer.");
  if (usage.maximumCost !== undefined && (!Number.isFinite(usage.maximumCost) || usage.maximumCost < 0)) throw new Error("usage.maximumCost must be zero or more.");
  if (usage.enabled && !usage.path) throw new Error("usage.path is required when usage metering is enabled.");
  if (usage.enabled && !isAbsolute(usage.path)) usage.path = resolve(basePath, usage.path);

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
