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
});
