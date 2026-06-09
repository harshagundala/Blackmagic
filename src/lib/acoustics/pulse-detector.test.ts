import { describe, expect, test } from "vitest";
import {
  detectPulse,
  synthesizeTonePulse,
} from "./pulse-detector";

function noisyWindow(length: number) {
  const samples = new Float32Array(length);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(index * 0.73) * 0.002;
  }
  return samples;
}

function add(samples: Float32Array, offset: number, template: Float32Array) {
  for (let index = 0; index < template.length; index += 1) {
    samples[offset + index] += template[index] * 0.65;
  }
}

describe("matched pulse detector", () => {
  test("synthesizes a tapered tone template with stable sample length", () => {
    const template = synthesizeTonePulse({
      frequencyHz: 2_000,
      durationMs: 12,
      sampleRate: 48_000,
    });

    expect(template).toHaveLength(576);
    expect(Math.abs(template[0])).toBeLessThan(0.001);
    expect(Math.max(...template)).toBeGreaterThan(0.8);
  });

  test("finds a known pulse start inside a noisy audio window", () => {
    const template = synthesizeTonePulse({
      frequencyHz: 2_000,
      durationMs: 12,
      sampleRate: 48_000,
    });
    const samples = noisyWindow(2_048);
    add(samples, 640, template);

    const detection = detectPulse(samples, template, {
      minScore: 0.42,
      minPeakRatio: 3,
    });

    expect(detection).toEqual(
      expect.objectContaining({
        startSample: 640,
        confidence: expect.any(Number),
      }),
    );
    expect(detection?.confidence).toBeGreaterThan(0.8);
    expect(detection?.score).toBeGreaterThan(0.9);
  });

  test("rejects uncorrelated low-energy windows", () => {
    const template = synthesizeTonePulse({
      frequencyHz: 2_000,
      durationMs: 12,
      sampleRate: 48_000,
    });

    expect(
      detectPulse(noisyWindow(2_048), template, {
        minScore: 0.42,
        minPeakRatio: 3,
      }),
    ).toBeNull();
  });
});
