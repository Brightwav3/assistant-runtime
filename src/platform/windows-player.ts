import type { PcmPlayerSpec } from "./contracts.js";

/**
 * Windows playback invocation. Owned by the Windows leaf, not by shared code:
 * preflight, tests, and streaming all read these exact arguments.
 */
export const WINDOWS_PCM_PLAYER: PcmPlayerSpec = {
  executable: "ffplay.exe",
  /** ffplay 8 removed the -ar/-ac shorthands; the raw PCM demuxer options are -sample_rate/-ch_layout. */
  args: (sampleRate: number): string[] => ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "s16le", "-sample_rate", String(sampleRate), "-ch_layout", "mono", "-i", "pipe:0"],
};
