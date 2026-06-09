export type RollingSampleWindow = {
  samples: Float32Array;
  startSampleIndex: number;
  endSampleIndexExclusive: number;
};

export class RollingSampleBuffer {
  private readonly samples: Float32Array;
  private writeOffset = 0;
  private available = 0;
  private nextSampleIndex: number | null = null;

  constructor(capacitySamples: number) {
    if (!Number.isInteger(capacitySamples) || capacitySamples <= 0) {
      throw new Error("RollingSampleBuffer capacity must be a positive integer.");
    }

    this.samples = new Float32Array(capacitySamples);
  }

  get capacitySamples() {
    return this.samples.length;
  }

  append(frame: Float32Array | number[], startSampleIndex: number) {
    const normalizedStart = Math.max(0, Math.round(startSampleIndex));
    if (
      this.nextSampleIndex !== null &&
      normalizedStart !== this.nextSampleIndex
    ) {
      this.clear();
    }

    for (const sample of frame) {
      this.samples[this.writeOffset] = sample;
      this.writeOffset = (this.writeOffset + 1) % this.samples.length;
      this.available = Math.min(this.samples.length, this.available + 1);
    }

    this.nextSampleIndex = normalizedStart + frame.length;
  }

  latest(maxSamples = this.capacitySamples): RollingSampleWindow | null {
    const length = Math.min(
      this.available,
      Math.max(0, Math.round(maxSamples)),
      this.samples.length,
    );
    if (length === 0 || this.nextSampleIndex === null) {
      return null;
    }

    const output = new Float32Array(length);
    const startOffset =
      (this.writeOffset - length + this.samples.length) % this.samples.length;
    for (let index = 0; index < length; index += 1) {
      output[index] = this.samples[(startOffset + index) % this.samples.length];
    }

    return {
      samples: output,
      startSampleIndex: this.nextSampleIndex - length,
      endSampleIndexExclusive: this.nextSampleIndex,
    };
  }

  clear() {
    this.samples.fill(0);
    this.writeOffset = 0;
    this.available = 0;
    this.nextSampleIndex = null;
  }
}
