import { PlatformUnsupportedError, type PlatformId, type PlatformServices } from "./contracts.js";

/**
 * Honest placeholder for a platform with no adapter. It reports `unsupported`
 * rather than throwing at import time, so the runtime can still start, expose
 * diagnostics, and report a degraded microphone/speech component instead of
 * faking hardware support.
 */
export function createUnsupportedPlatformServices(id: PlatformId, reason: string): PlatformServices {
  const fail = (): never => { throw new PlatformUnsupportedError(id, reason); };
  return {
    id,
    capability: { status: "unsupported", reason },
    player: { executable: "", args: () => [] },
    createActivationListener: fail,
  };
}
