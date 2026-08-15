import { LocalClapListener, type ClapListener, type ClapListenerOptions, type DoubleClapProvider } from "activation-core";
import { WINDOWS_PCM_PLAYER } from "./windows-player.js";
import type { PlatformServices } from "./contracts.js";

/** Windows leaf: double-clap capture and ffplay playback for the Gemini Live path. */
export function createWindowsPlatformServices(): PlatformServices {
  return {
    id: "win32",
    capability: { status: "supported" },
    player: WINDOWS_PCM_PLAYER,
    createActivationListener: (provider: DoubleClapProvider, options: ClapListenerOptions): ClapListener => new LocalClapListener(provider, options),
  };
}
