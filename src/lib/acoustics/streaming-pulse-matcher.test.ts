import { describe, expect, test } from "vitest";
import {
  StreamingPulseMatcher,
  type TrackedPulse,
} from "./streaming-pulse-matcher";
import { synthesizePulseTemplate } from "./pulse-detector";

function add(
  samples: Float32Array,
  offset: number,
  template: Float32Array,
  gain = 0.7,
) {
  for (let index = 0; index < template.length; index += 1) {
    samples[offset + index] += template[index] * gain;
  }
}

function frame(source: Float32Array, start: number, length: number) {
  return source.slice(start, start + length);
}

describe("streaming pulse matcher", () => {
  test("detects a tracked chirp as soon as enough rolling samples arrive", () => {
    const sampleRate = 48_000;
    const pulse: TrackedPulse = {
      id: "pulse-a",
      frequencyHz: 1_700,
      endFrequencyHz: 3_600,
      durationMs: 16,
      expectedStartSampleIndex: 1_024,
      maxLateSamples: 480,
    };
    const template = synthesizePulseTemplate({
      frequencyHz: pulse.frequencyHz,
      endFrequencyHz: pulse.endFrequencyHz,
      durationMs: pulse.durationMs,
      sampleRate,
    });
    const samples = new Float32Array(2_560);
    add(samples, pulse.expectedStartSampleIndex + 220, template);

    const matcher = new StreamingPulseMatcher({
      sampleRate,
      historySamples: 2_048,
      minScore: 0.42,
      minPeakRatio: 3,
    });
    matcher.track(pulse);

    expect(matcher.append(frame(samples, 0, 512), 0)).toBeNull();
    expect(matcher.append(frame(samples, 512, 512), 512)).toBeNull();
    const detection = matcher.append(frame(samples, 1_024, 1_024), 1_024);

    expect(detection).toEqual(
      expect.objectContaining({
        pulseId: "pulse-a",
        startSampleIndex: 1_244,
      }),
    );
    expect(detection?.detection.confidence).toBeGreaterThan(0.8);
  });

  test("does not emit the same pulse twice", () => {
    const sampleRate = 48_000;
    const pulse: TrackedPulse = {
      id: "pulse-b",
      frequencyHz: 1_800,
      endFrequencyHz: 3_200,
      durationMs: 12,
      expectedStartSampleIndex: 512,
      maxLateSamples: 360,
    };
    const template = synthesizePulseTemplate({
      frequencyHz: pulse.frequencyHz,
      endFrequencyHz: pulse.endFrequencyHz,
      durationMs: pulse.durationMs,
      sampleRate,
    });
    const samples = new Float32Array(1_800);
    add(samples, 640, template);
    const matcher = new StreamingPulseMatcher({ sampleRate, historySamples: 1_500 });
    matcher.track(pulse);

    const first = matcher.append(frame(samples, 0, 1_400), 0);
    const second = matcher.append(frame(samples, 1_400, 256), 1_400);

    expect(first).toEqual(
      expect.objectContaining({
        pulseId: "pulse-b",
        startSampleIndex: 640,
      }),
    );
    expect(second).toBeNull();
  });

  test("upgrades a weak same-pulse hit when a stronger candidate arrives before the search horizon closes", () => {
    const sampleRate = 48_000;
    const pulse: TrackedPulse = {
      id: "pulse-c",
      frequencyHz: 1_800,
      endFrequencyHz: 3_200,
      durationMs: 12,
      expectedStartSampleIndex: 512,
      maxLateSamples: 1_280,
    };
    const template = synthesizePulseTemplate({
      frequencyHz: pulse.frequencyHz,
      endFrequencyHz: pulse.endFrequencyHz,
      durationMs: pulse.durationMs,
      sampleRate,
    });
    const samples = new Float32Array(2_600);
    add(samples, 640, template, 0.18);
    add(samples, 1_260, template, 0.72);
    const matcher = new StreamingPulseMatcher({
      sampleRate,
      historySamples: 2_048,
      minScore: 0.42,
      minPeakRatio: 2.4,
    });
    matcher.track(pulse);

    const first = matcher.append(frame(samples, 0, 1_220), 0);
    const upgraded = matcher.append(frame(samples, 1_220, 940), 1_220);

    expect(first).toEqual(
      expect.objectContaining({
        pulseId: "pulse-c",
        startSampleIndex: 640,
      }),
    );
    expect(upgraded).toEqual(
      expect.objectContaining({
        pulseId: "pulse-c",
        startSampleIndex: 1_260,
      }),
    );
    expect(upgraded?.detection.amplitude).toBeGreaterThan(
      (first?.detection.amplitude ?? 0) * 2,
    );
  });
});
