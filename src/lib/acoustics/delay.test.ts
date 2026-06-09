import { describe, expect, test } from "vitest";
import {
  estimateDelaySamples,
  lagSamplesToMeters,
  rms,
} from "./delay";

function impulseTrain(length: number, impulses: number[]) {
  const samples = new Float32Array(length);
  for (const index of impulses) {
    samples[index] = 1;
    samples[index + 1] = 0.45;
    samples[index + 2] = -0.2;
  }
  return samples;
}

describe("acoustic delay estimation", () => {
  test("finds the sample lag between two similar calibration waveforms", () => {
    const reference = impulseTrain(256, [32, 96, 180]);
    const observed = impulseTrain(256, [39, 103, 187]);

    const result = estimateDelaySamples(reference, observed, { maxLag: 24 });

    expect(result.lagSamples).toBe(7);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  test("resolves a fractional lag between band-limited waveforms", () => {
    const sampleRate = 48_000;
    const length = 512;
    const trueShift = 6.6;
    const gaussianBurst = (center: number) => {
      const samples = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        const t = index - center;
        samples[index] =
          Math.exp(-(t * t) / (2 * 18 * 18)) *
          Math.cos((2 * Math.PI * 2_400 * t) / sampleRate);
      }
      return samples;
    };

    const reference = gaussianBurst(200);
    const observed = gaussianBurst(200 + trueShift);

    const result = estimateDelaySamples(reference, observed, { maxLag: 24 });

    expect(result.lagSamples).toBe(7);
    expect(Math.abs(result.refinedLagSamples - trueShift)).toBeLessThan(0.2);
  });

  test("converts sample lag to one-way acoustic distance", () => {
    const meters = lagSamplesToMeters(480, 48_000);

    expect(meters).toBeCloseTo(3.43, 2);
  });

  test("measures RMS energy for microphone frames", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
  });
});
