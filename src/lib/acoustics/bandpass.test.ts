import { describe, expect, it } from "vitest";
import { isolateChirpBand } from "./bandpass";

const SAMPLE_RATE = 48_000;

function rms(samples: Float32Array, from = 0, to = samples.length) {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
}

function tone(freqHz: number, length: number, amplitude = 1) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE);
  }
  return out;
}

describe("isolateChirpBand", () => {
  it("keeps the chirp band flat while crushing loud voice-band energy", () => {
    const length = SAMPLE_RATE; // 1 s
    const lo = SAMPLE_RATE * 0.2;
    const hi = SAMPLE_RATE * 0.8;
    // Every frequency across an 18.5-20.5 kHz chirp band survives nearly
    // intact (a band-pass biquad would notch the edges near Nyquist).
    for (const freq of [18_500, 19_500, 20_500]) {
      const inBand = tone(freq, length, 0.05);
      const filtered = isolateChirpBand(inBand, SAMPLE_RATE, 18_500);
      expect(rms(filtered, lo, hi), `${freq} Hz`).toBeGreaterThan(
        rms(inBand, lo, hi) * 0.7,
      );
    }
    // A loud 300 Hz talker (20x the chirp level) is cut by >40 dB.
    const voice = tone(300, length, 1.0);
    const filteredVoice = isolateChirpBand(voice, SAMPLE_RATE, 18_500);
    expect(rms(filteredVoice, lo, hi)).toBeLessThan(rms(voice, lo, hi) / 100);
  });

  it("does not shift the signal in time (zero phase)", () => {
    const length = 4_096;
    const center = 2_048;
    const half = 240;
    const burst = new Float32Array(length);
    for (let i = -half; i < half; i += 1) {
      const taper = 0.5 + 0.5 * Math.cos((Math.PI * i) / half);
      burst[center + i] =
        taper * Math.sin((2 * Math.PI * 19_500 * i) / SAMPLE_RATE);
    }
    const filtered = isolateChirpBand(burst, SAMPLE_RATE, 18_500);
    const centroid = (s: Float32Array) => {
      let num = 0;
      let den = 0;
      for (let i = 0; i < s.length; i += 1) {
        const e = s[i] * s[i];
        num += i * e;
        den += e;
      }
      return num / den;
    };
    expect(Math.abs(centroid(filtered) - centroid(burst))).toBeLessThan(3);
  });

  it("returns the input unchanged when there is no usable headroom", () => {
    const samples = tone(8_000, 1_000, 0.1);
    // 16 kHz capture: Nyquist 8 kHz, no room for an ultrasonic band.
    const filtered = isolateChirpBand(samples, 16_000, 18_500);
    expect(filtered).toBe(samples);
  });
});
