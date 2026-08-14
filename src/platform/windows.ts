import { LocalClapListener, type ClapListener, type ClapListenerOptions, type DoubleClapProvider } from "activation-core";
import { WindowsAudioOutput, WindowsSpeechRecognitionProvider, WindowsSpeechTtsProvider } from "scribe-core";
import { WINDOWS_PCM_PLAYER } from "./windows-player.js";
import type { PlatformServices, PlatformSpeechStack } from "./contracts.js";

/** Windows leaf: decibri capture, ffplay playback, System.Speech STT/TTS. Hardware-verified. */
export function createWindowsPlatformServices(): PlatformServices {
  return {
    id: "win32",
    capability: { status: "supported" },
    player: WINDOWS_PCM_PLAYER,
    createActivationListener: (provider: DoubleClapProvider, options: ClapListenerOptions): ClapListener => new LocalClapListener(provider, options),
    createSpeechStack: (): PlatformSpeechStack => ({
      stt: new WindowsSpeechRecognitionProvider(),
      tts: new WindowsSpeechTtsProvider(),
      output: new WindowsAudioOutput(WINDOWS_PCM_PLAYER.executable),
      descriptor: { stt: "windows_speech_recognition", tts: "windows_speech_synthesis" },
    }),
  };
}
