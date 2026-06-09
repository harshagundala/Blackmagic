import {
  detectPulse,
  synthesizePulseTemplate,
  type PulseDetection,
} from "./pulse-detector";
import { RollingSampleBuffer } from "./rolling-buffer";

export type TrackedPulse = {
  id: string;
  frequencyHz: number;
  endFrequencyHz?: number | null;
  durationMs: number;
  expectedStartSampleIndex: number;
  maxLateSamples: number;
};

export type StreamingPulseMatcherOptions = {
  sampleRate: number;
  historySamples: number;
  minScore?: number;
  minPeakRatio?: number;
};

export type StreamingPulseDetection = {
  pulseId: string;
  startSampleIndex: number;
  detection: PulseDetection;
};

export class StreamingPulseMatcher {
  private readonly buffer: RollingSampleBuffer;
  private trackedPulse: TrackedPulse | null = null;
  private emittedPulseId = "";

  constructor(private readonly options: StreamingPulseMatcherOptions) {
    this.buffer = new RollingSampleBuffer(options.historySamples);
  }

  track(pulse: TrackedPulse | null) {
    if (!pulse) {
      this.trackedPulse = null;
      return;
    }

    if (this.trackedPulse?.id !== pulse.id) {
      this.emittedPulseId = "";
    }
    this.trackedPulse = pulse;
  }

  append(
    samples: Float32Array | number[],
    startSampleIndex: number,
  ): StreamingPulseDetection | null {
    this.buffer.append(samples, startSampleIndex);
    return this.detect();
  }

  latestWindow(maxSamples = this.options.historySamples) {
    return this.buffer.latest(maxSamples);
  }

  clear() {
    this.buffer.clear();
    this.trackedPulse = null;
    this.emittedPulseId = "";
  }

  private detect(): StreamingPulseDetection | null {
    const pulse = this.trackedPulse;
    if (!pulse || pulse.id === this.emittedPulseId) {
      return null;
    }

    const window = this.buffer.latest(this.options.historySamples);
    if (!window) {
      return null;
    }

    const template = synthesizePulseTemplate({
      frequencyHz: pulse.frequencyHz,
      endFrequencyHz: pulse.endFrequencyHz ?? undefined,
      durationMs: pulse.durationMs,
      sampleRate: this.options.sampleRate,
    });
    const searchStartSample = Math.max(
      0,
      pulse.expectedStartSampleIndex - window.startSampleIndex,
    );
    const searchEndSample = Math.min(
      window.samples.length - template.length,
      pulse.expectedStartSampleIndex +
        pulse.maxLateSamples -
        window.startSampleIndex,
    );
    if (searchEndSample < searchStartSample) {
      return null;
    }

    const detection = detectPulse(window.samples, template, {
      searchStartSample,
      searchEndSample,
      minScore: this.options.minScore,
      minPeakRatio: this.options.minPeakRatio,
    });
    if (!detection) {
      return null;
    }

    this.emittedPulseId = pulse.id;
    return {
      pulseId: pulse.id,
      startSampleIndex: window.startSampleIndex + detection.startSample,
      detection,
    };
  }
}
