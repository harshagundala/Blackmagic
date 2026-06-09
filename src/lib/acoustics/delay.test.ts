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

  test("converts sample lag to one-way acoustic distance", () => {
    const meters = lagSamplesToMeters(480, 48_000);

    expect(meters).toBeCloseTo(3.43, 2);
  });

  test("measures RMS energy for microphone frames", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
  });
});
