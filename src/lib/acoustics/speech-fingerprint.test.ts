import { describe, expect, test } from "vitest";
import {
  createSpeechFingerprint,
  estimateFingerprintOffset,
} from "./speech-fingerprint";

describe("speech audio fingerprints", () => {
  test("extracts a compact normalized energy contour around a sample", () => {
    const sampleRate = 1_000;
    const samples = new Float32Array(400);
    for (let index = 185; index < 215; index += 1) {
      samples[index] = 0.7;
    }

    const fingerprint = createSpeechFingerprint({
      samples,
      sampleRate,
      startSampleIndex: 0,
      centerSampleIndex: 200,
      windowMs: 160,
      bins: 16,
    });

    expect(fingerprint).toEqual(
      expect.objectContaining({
        sampleRate: 1_000,
        startSampleIndex: 120,
        centerSampleIndex: 200,
        hopMs: 10,
        windowMs: 160,
      }),
    );
    expect(fingerprint?.values).toHaveLength(16);
    expect(Math.max(...(fingerprint?.values ?? []))).toBe(1);
    expect((fingerprint?.values ?? []).filter((value) => value > 0.2).length).toBeGreaterThan(1);
  });

  test("extracts a signed alignment sketch for finer delay estimates", () => {
    const sampleRate = 1_000;
    const samples = new Float32Array(400);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((2 * Math.PI * index) / 16);
    }

    const fingerprint = createSpeechFingerprint({
      samples,
      sampleRate,
      startSampleIndex: 0,
      centerSampleIndex: 200,
      windowMs: 128,
      bins: 16,
      alignmentBins: 64,
    });

    expect(fingerprint).toEqual(
      expect.objectContaining({
        alignmentHopMs: 2,
        alignmentWindowMs: 128,
      }),
    );
    expect(fingerprint?.alignmentValues).toHaveLength(64);
    expect(Math.max(...(fingerprint?.alignmentValues ?? []))).toBeCloseTo(1, 2);
    expect(Math.min(...(fingerprint?.alignmentValues ?? []))).toBeLessThan(-0.9);
  });

  test("estimates a delayed matching fingerprint offset", () => {
    const reference = {
      sampleRate: 1_000,
      startSampleIndex: 0,
      centerSampleIndex: 200,
      hopMs: 5,
      windowMs: 80,
      values: [0, 0.1, 0.35, 1, 0.7, 0.28, 0.1, 0],
    };
    const delayed = {
      ...reference,
      values: [0, 0, 0, 0.1, 0.35, 1, 0.7, 0.28],
    };

    const offset = estimateFingerprintOffset(reference, delayed, { maxLagBins: 3 });

    expect(offset).toEqual(
      expect.objectContaining({
        offsetMs: 10,
        lagBins: 2,
      }),
    );
    expect(offset?.correlation).toBeGreaterThan(0.85);
  });

  test("prefers signed alignment sketch for finer offset estimates", () => {
    const alignment = [0, 0.22, 0.72, 1, 0.62, -0.2, -0.75, -1, -0.55, 0.1, 0.65, 0.95];
    const reference = {
      sampleRate: 1_000,
      startSampleIndex: 0,
      centerSampleIndex: 200,
      hopMs: 8,
      windowMs: 96,
      values: [0, 0.1, 1, 0.2, 0],
      alignmentHopMs: 2,
      alignmentWindowMs: 24,
      alignmentValues: alignment,
    };
    const delayed = {
      ...reference,
      alignmentValues: [0, 0, ...alignment.slice(0, -2)],
      values: [0, 0.1, 1, 0.2, 0],
    };

    const offset = estimateFingerprintOffset(reference, delayed, {
      maxLagBins: 3,
      maxAlignmentLagBins: 5,
    });

    expect(offset).toEqual(
      expect.objectContaining({
        offsetMs: 4,
        lagBins: 2,
        source: "alignment-sketch",
      }),
    );
    expect(offset?.correlation).toBeGreaterThan(0.85);
  });
});
