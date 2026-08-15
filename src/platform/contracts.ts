import type { ClapListener, ClapListenerOptions, DoubleClapProvider } from "activation-core";

/** Every platform the factory can be asked about. `process.platform` values outside this set resolve to `unknown`. */
export type PlatformId = "win32" | "darwin" | "linux" | "unknown";

/**
 * How much of the platform leaf is real.
 * - `supported`: an adapter exists and its behaviour is implemented.
 * - `degraded`: an adapter exists but part of the stack is missing at runtime.
 * - `unsupported`: no adapter exists; the runtime must not pretend otherwise.
 */
export type PlatformStatus = "supported" | "degraded" | "unsupported";

export interface PlatformCapability {
  status: PlatformStatus;
  /** Human-readable cause. Required whenever the status is not `supported`. */
  reason?: string;
}

/** Playback invocation spec: one source of truth shared by preflight, tests, and streaming. */
export interface PcmPlayerSpec {
  executable: string;
  args(sampleRate: number): string[];
}

/**
 * The complete platform boundary. Shared composition depends on this interface
 * and never imports a concrete `Windows*`/`Darwin*`/`Linux*` implementation.
 */
export interface PlatformServices {
  readonly id: PlatformId;
  readonly capability: PlatformCapability;
  /** Playback spec for realtime PCM output. */
  readonly player: PcmPlayerSpec;
  /** Throws `PlatformUnsupportedError` when `capability.status === "unsupported"`. */
  createActivationListener(provider: DoubleClapProvider, options: ClapListenerOptions): ClapListener;
}

export class PlatformUnsupportedError extends Error {
  readonly code = "PLATFORM_UNSUPPORTED";
  constructor(public readonly platform: PlatformId, message: string) {
    super(message);
    this.name = "PlatformUnsupportedError";
  }
}
