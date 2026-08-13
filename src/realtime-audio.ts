export const REALTIME_MICROPHONE_STREAM_ID = "windows-default-microphone";
export const REALTIME_INPUT_FRAME_SAMPLES = 320;

/** Converts arbitrary capture chunks into copied, complete realtime PCM frames. */
export class PcmInputFrameizer {
  private remainder = new Int16Array(0);

  constructor(private readonly frameSamples = REALTIME_INPUT_FRAME_SAMPLES) {
    if (!Number.isInteger(frameSamples) || frameSamples < 1) throw new Error("frameSamples must be a positive integer.");
  }

  push(data: Int16Array): Int16Array[] {
    if (data.length === 0) return [];
    const combined = new Int16Array(this.remainder.length + data.length);
    combined.set(this.remainder);
    combined.set(data, this.remainder.length);
    const completeSamples = combined.length - (combined.length % this.frameSamples);
    const frames: Int16Array[] = [];
    for (let offset = 0; offset < completeSamples; offset += this.frameSamples) frames.push(combined.slice(offset, offset + this.frameSamples));
    this.remainder = combined.slice(completeSamples);
    return frames;
  }

  reset(): void {
    this.remainder = new Int16Array(0);
  }
}
