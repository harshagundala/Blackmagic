import { describe, expect, test } from "vitest";
import {
  captureAudioSnippet,
  decodeAudioSnippet,
  estimateRawAudioOffset,
  isPlausibleAudioSnippet,
} from "./audio-snippet";

const SOURCE_RATE = 48_000;

// Deterministic pseudo-random generator so the "speech" is reproducible.
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Speech-like test signal: band-limited noise bursts with a syllabic envelope.
function speechLikeSignal(lengthSamples: number, seed: number) {
  const random = mulberry32(seed);
  const raw = new Float32Array(lengthSamples);
  for (let index = 0; index < lengthSamples; index += 1) {
    raw[index] = random() * 2 - 1;
  }
  // Crude band-pass: difference of two moving averages (~300-3000 Hz shape).
  const smoothed = movingAverage(raw, 16);
  const band = new Float32Array(lengthSamples);
  const wide = movingAverage(raw, 160);
  for (let index = 0; index < lengthSamples; index += 1) {
    const envelope =
      0.4 +
      0.6 * Math.abs(Math.sin((2 * Math.PI * 4 * index) / SOURCE_RATE));
    band[index] = (smoothed[index] - wide[index]) * envelope;
  }
  return band;
}

function movingAverage(samples: Float32Array, window: number) {
  const output = new Float32Array(samples.length);
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index];
    if (index >= window) {
      sum -= samples[index - window];
    }
    output[index] = sum / Math.min(window, index + 1);
  }
  return output;
}

// Delays a signal by a fractional number of samples with linear interpolation
// and adds a decaying early reflection plus independent noise.
function roomCapture(
  source: Float32Array,
  delaySamples: number,
  noiseSeed: number,
  reflectionDelaySamples = 220,
  reflectionGain = 0.35,
  noiseLevel = 0.02,
) {
  const random = mulberry32(noiseSeed);
  const output = new Float32Array(source.length);
  const readAt = (position: number) => {
    if (position < 0 || position >= source.length - 1) {
      return 0;
    }
    const base = Math.floor(position);
    const fraction = position - base;
    return source[base] * (1 - fraction) + source[base + 1] * fraction;
  };
  for (let index = 0; index < output.length; index += 1) {
    output[index] =
      readAt(index - delaySamples) +
      reflectionGain * readAt(index - delaySamples - reflectionDelaySamples) +
      (random() * 2 - 1) * noiseLevel;
  }
  return output;
}

describe("audio snippets", () => {
  test("round-trips capture, encoding, and decoding", () => {
    const signal = speechLikeSignal(SOURCE_RATE, 7);
    const snippet = captureAudioSnippet({
      samples: signal,
      sampleRate: SOURCE_RATE,
      startSampleIndex: 0,
      centerSampleIndex: 24_000,
    });

    expect(snippet).not.toBeNull();
    expect(isPlausibleAudioSnippet(snippet)).toBe(true);
    expect(snippet?.sampleRate).toBe(8_000);
    expect(snippet?.windowMs).toBeCloseTo(240, 0);

    const decoded = decodeAudioSnippet(snippet);
    expect(decoded).not.toBeNull();
    expect(decoded?.length).toBe(1_920);
    expect(Math.max(...(decoded ?? []))).toBeGreaterThan(0.5);
  });

  test("GCC-PHAT recovers a fractional inter-device delay under reverb and noise", () => {
    const trueDelayMs = 8.4; // ≈ 2.9 m of sound travel
    const trueDelaySamples = (trueDelayMs / 1_000) * SOURCE_RATE;
    const source = speechLikeSignal(SOURCE_RATE, 21);
    const deviceA = roomCapture(source, 0, 1001);
    const deviceB = roomCapture(source, trueDelaySamples, 2002);
    const centerSample = 24_000;

    // Both devices cut their snippet around the same nominal sample index, so
    // the content lag equals the true acoustic delay.
    const snippetA = captureAudioSnippet({
      samples: deviceA,
      sampleRate: SOURCE_RATE,
      startSampleIndex: 0,
      centerSampleIndex: centerSample,
    });
    const snippetB = captureAudioSnippet({
      samples: deviceB,
      sampleRate: SOURCE_RATE,
      startSampleIndex: 0,
      centerSampleIndex: centerSample,
    });

    const estimate = estimateRawAudioOffset(snippetA, snippetB);

    expect(estimate).not.toBeNull();
    expect(estimate?.correlation).toBeGreaterThan(0.5);
    expect(Math.abs((estimate?.offsetMs ?? 0) - trueDelayMs)).toBeLessThan(0.2);
  });

  test("reports low correlation for unrelated audio", () => {
    const snippetA = captureAudioSnippet({
      samples: speechLikeSignal(SOURCE_RATE, 5),
      sampleRate: SOURCE_RATE,
      startSampleIndex: 0,
      centerSampleIndex: 24_000,
    });
    const snippetB = captureAudioSnippet({
      samples: speechLikeSignal(SOURCE_RATE, 99),
      sampleRate: SOURCE_RATE,
      startSampleIndex: 0,
      centerSampleIndex: 24_000,
    });

    const estimate = estimateRawAudioOffset(snippetA, snippetB);

    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate?.correlation ?? 1)).toBeLessThan(0.3);
  });

  test("rejects malformed snippets", () => {
    expect(isPlausibleAudioSnippet(null)).toBe(false);
    expect(
      isPlausibleAudioSnippet({
        sampleRate: 8_000,
        sourceSampleRate: 48_000,
        startSampleIndex: 0,
        centerSampleIndex: 0,
        windowMs: 240,
        peakLevel: 0.5,
        encodedSamples: "not base64!!",
      }),
    ).toBe(false);
    expect(decodeAudioSnippet(null)).toBeNull();
  });
});
