// Accumulates the full-resolution capture stream during a recording session.
// Chunks arrive straight from the AudioWorklet (128-sample quanta with their
// ADC sample indices), are quantized to 16-bit on the fly to halve memory,
// and any sample-index discontinuity (dropped quanta, capture-graph rebuild)
// is recorded rather than silently concatenated — ground-truth analysis must
// know where the sample timeline broke.

import { floatToPcm16 } from "./wav";

export type RecordedTake = {
  recordingId: string;
  samples: Int16Array;
  sampleRate: number;
  firstSampleIndex: number;
  lastSampleIndex: number;
  // Each entry marks a break in the worklet sample counter: offset into the
  // recorded buffer where it happened and how many source samples vanished
  // (negative = counter went backwards, i.e. the capture graph restarted).
  discontinuities: Array<{ atRecordedSample: number; missingSamples: number }>;
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  truncated: boolean;
};

export type CaptureRecorderMeta = {
  recordingId: string;
  startedAtEpochMs: number;
};

// ~3 minutes at 48 kHz as Int16 ≈ 17 MB — safe for mobile Safari memory.
const MAX_RECORDED_SAMPLES = 48_000 * 180;

export class CaptureRecorder {
  private meta: CaptureRecorderMeta | null = null;
  private chunks: Int16Array[] = [];
  private totalSamples = 0;
  private sampleRate: number | null = null;
  private firstSampleIndex: number | null = null;
  private expectedNextIndex: number | null = null;
  private discontinuities: Array<{
    atRecordedSample: number;
    missingSamples: number;
  }> = [];
  private truncated = false;

  get active() {
    return this.meta !== null;
  }

  get recordingId() {
    return this.meta?.recordingId ?? null;
  }

  get recordedSamples() {
    return this.totalSamples;
  }

  begin(meta: CaptureRecorderMeta) {
    this.meta = meta;
    this.chunks = [];
    this.totalSamples = 0;
    this.sampleRate = null;
    this.firstSampleIndex = null;
    this.expectedNextIndex = null;
    this.discontinuities = [];
    this.truncated = false;
  }

  append(
    samples: Float32Array,
    startSampleIndex: number,
    sampleRate: number,
  ) {
    if (!this.meta || samples.length === 0 || this.truncated) {
      return;
    }
    if (this.totalSamples + samples.length > MAX_RECORDED_SAMPLES) {
      this.truncated = true;
      return;
    }

    this.sampleRate = this.sampleRate ?? sampleRate;
    this.firstSampleIndex = this.firstSampleIndex ?? startSampleIndex;
    if (
      this.expectedNextIndex !== null &&
      startSampleIndex !== this.expectedNextIndex
    ) {
      this.discontinuities.push({
        atRecordedSample: this.totalSamples,
        missingSamples: startSampleIndex - this.expectedNextIndex,
      });
    }
    this.expectedNextIndex = startSampleIndex + samples.length;
    this.chunks.push(floatToPcm16(samples));
    this.totalSamples += samples.length;
  }

  end(endedAtEpochMs: number): RecordedTake | null {
    const meta = this.meta;
    this.meta = null;
    if (
      !meta ||
      this.totalSamples === 0 ||
      this.sampleRate === null ||
      this.firstSampleIndex === null ||
      this.expectedNextIndex === null
    ) {
      return null;
    }

    const samples = new Int16Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    return {
      recordingId: meta.recordingId,
      samples,
      sampleRate: this.sampleRate,
      firstSampleIndex: this.firstSampleIndex,
      lastSampleIndex: this.expectedNextIndex - 1,
      discontinuities: this.discontinuities,
      startedAtEpochMs: meta.startedAtEpochMs,
      endedAtEpochMs,
      truncated: this.truncated,
    };
  }
}
