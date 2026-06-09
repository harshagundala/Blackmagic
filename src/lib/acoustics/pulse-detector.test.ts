import { describe, expect, test } from "vitest";
import {
  detectPulse,
  synthesizePulseTemplate,
  synthesizeQuadraturePulseTemplate,
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

function addFractionalChirp(
  samples: Float32Array,
  startSample: number,
  options: {
    frequencyHz: number;
    endFrequencyHz: number;
    durationMs: number;
    sampleRate: number;
    gain: number;
  },
) {
  const durationSeconds = options.durationMs / 1_000;
  const length = Math.round(durationSeconds * options.sampleRate);
  const sweepHzPerSecond =
    (options.endFrequencyHz - options.frequencyHz) / durationSeconds;
  const first = Math.ceil(startSample);
  for (let index = first; index < startSample + length; index += 1) {
    const seconds = (index - startSample) / options.sampleRate;
    if (seconds < 0 || seconds > durationSeconds) {
      continue;
    }
    const phase =
      2 *
      Math.PI *
      (options.frequencyHz * seconds +
        0.5 * sweepHzPerSecond * seconds * seconds);
    const relative = (index - startSample) / Math.max(1, length - 1);
    const taper = 0.5 - 0.5 * Math.cos(2 * Math.PI * relative);
    samples[index] += Math.sin(phase) * taper * options.gain;
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

  test("finds a linear chirp pulse without relying on a single tone", () => {
    const template = synthesizePulseTemplate({
      frequencyHz: 1_600,
      endFrequencyHz: 3_400,
      durationMs: 18,
      sampleRate: 48_000,
    });
    const samples = noisyWindow(2_560);
    add(samples, 900, template);

    const detection = detectPulse(samples, template, {
      minScore: 0.42,
      minPeakRatio: 3,
    });

    expect(detection).toEqual(
      expect.objectContaining({
        startSample: 900,
        score: expect.closeTo(1, 2),
      }),
    );
    expect(detection?.confidence).toBeGreaterThan(0.8);
  });

  test("prefers the louder matching chirp when two candidates have similar normalized correlation", () => {
    const template = synthesizePulseTemplate({
      frequencyHz: 1_600,
      endFrequencyHz: 3_400,
      durationMs: 18,
      sampleRate: 48_000,
    });
    const samples = new Float32Array(3_400);
    for (let index = 0; index < template.length; index += 1) {
      samples[640 + index] += template[index] * 0.16;
    }
    add(samples, 1_640, template);

    const detection = detectPulse(samples, template, {
      minScore: 0.42,
      minPeakRatio: 2.4,
      searchStartSample: 500,
      searchEndSample: 1_900,
    });

    expect(detection).toEqual(
      expect.objectContaining({
        startSample: 1_640,
        score: expect.any(Number),
      }),
    );
    expect(detection?.score).toBeGreaterThan(0.98);
    expect(detection?.peakRatio).toBeGreaterThan(2.4);
  });

  test("recovers a fractional pulse start with sub-sample interpolation", () => {
    const chirp = {
      frequencyHz: 1_600,
      endFrequencyHz: 3_400,
      durationMs: 18,
      sampleRate: 48_000,
    };
    const template = synthesizePulseTemplate(chirp);
    const trueStart = 900.4;
    const samples = noisyWindow(2_560);
    addFractionalChirp(samples, trueStart, { ...chirp, gain: 0.65 });

    const detection = detectPulse(samples, template, {
      minScore: 0.42,
      minPeakRatio: 2.4,
    });

    expect(detection?.startSample).toBe(900);
    expect(detection?.refinedStartSample).toBeCloseTo(trueStart, 0);
    expect(
      Math.abs((detection?.refinedStartSample ?? 0) - trueStart),
    ).toBeLessThan(0.25);
  });

  test("envelope matching resolves the production ultrasound chirp to sub-sample accuracy", () => {
    const chirp = {
      frequencyHz: 17_200,
      endFrequencyHz: 19_200,
      durationMs: 48,
      sampleRate: 48_000,
    };
    const template = synthesizePulseTemplate(chirp);
    const quadratureTemplate = synthesizeQuadraturePulseTemplate(chirp);
    const trueStart = 1_200.6;
    const samples = noisyWindow(6_144);
    addFractionalChirp(samples, trueStart, { ...chirp, gain: 0.5 });

    const detection = detectPulse(samples, template, {
      minScore: 0.3,
      minPeakRatio: 1.6,
      quadratureTemplate,
    });

    expect(detection).not.toBeNull();
    const refinedError = Math.abs(
      (detection?.refinedStartSample ?? 0) - trueStart,
    );
    expect(detection?.startSample).toBeGreaterThanOrEqual(1_200);
    expect(detection?.startSample).toBeLessThanOrEqual(1_201);
    expect(refinedError).toBeLessThan(0.35);
  });

  test("envelope matching tolerates a carrier phase shift in the captured chirp", () => {
    const chirp = {
      frequencyHz: 17_200,
      endFrequencyHz: 19_200,
      durationMs: 48,
      sampleRate: 48_000,
    };
    const template = synthesizePulseTemplate(chirp);
    const quadratureTemplate = synthesizeQuadraturePulseTemplate(chirp);
    const samples = noisyWindow(6_144);
    // Inject the quadrature waveform: a 90-degree carrier rotation like the
    // phase distortion device processing can apply near Nyquist.
    for (let index = 0; index < quadratureTemplate.length; index += 1) {
      samples[1_400 + index] += quadratureTemplate[index] * 0.5;
    }

    const detection = detectPulse(samples, template, {
      minScore: 0.3,
      minPeakRatio: 1.6,
      quadratureTemplate,
    });

    expect(detection).not.toBeNull();
    expect(detection?.startSample).toBe(1_400);
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
