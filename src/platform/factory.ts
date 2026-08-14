import { createUnsupportedPlatformServices } from "./unsupported.js";
import { createWindowsPlatformServices } from "./windows.js";
import type { PlatformId, PlatformServices } from "./contracts.js";

const NO_ADAPTER = (name: string) =>
  `No ${name} platform adapter exists yet. Microphone capture, playback, and local speech are unavailable on this host; only deterministic and network-only paths will run.`;

export function normalizePlatform(platform: string): PlatformId {
  return platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "unknown";
}

/**
 * The single platform selection point for the whole runtime.
 * Pass an explicit platform in tests; production passes `process.platform`.
 */
export function createPlatformServices(platform: string = process.platform): PlatformServices {
  const id = normalizePlatform(platform);
  switch (id) {
    case "win32": return createWindowsPlatformServices();
    case "darwin": return createUnsupportedPlatformServices("darwin", NO_ADAPTER("macOS"));
    case "linux": return createUnsupportedPlatformServices("linux", NO_ADAPTER("Linux"));
    default: return createUnsupportedPlatformServices("unknown", `Platform '${platform}' is not recognised by this runtime.`);
  }
}
