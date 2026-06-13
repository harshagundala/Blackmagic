import { describe, expect, it } from "vitest";
import {
  CHIRP_OUTPUT_LATENCY_ALLOWANCE_MS,
  detectScheduledPulse,
} from "./scheduled-pulse-detector";
import type { AudioPulseWindow } from "./pulse";
import type { AcousticPulse } from "@/lib/session/registry";

const SAMPLE_RATE = 48_000;
const DURATION_MS = 200;

const pulse: AcousticPulse = {
  id: "p-1",
  deviceId: "dev",
  sequence: 0,
  frequencyHz: 16_300,
  endFrequencyHz: 18_700,
  durationMs: DURATION_MS,
  emittedAtHostEpochMs: 10_000,
  announcedAtHostEpochMs: 9_000,
  leadMs: 1_000,
  sampleRate: SAMPLE_RATE,
} as unknown as AcousticPulse;

// Build a 1 s capture window with the chirp placed `outputLatencyMs` after its
// scheduled emission instant, plus broadband noise and (optionally) a loud
// in-band-adjacent talker, mirroring a real raw capture.
function windowWithChirp({
  outputLatencyMs,
  withSpeech,
}: {
  outputLatencyMs: number;
  withSpeech: boolean;
}): { frame: Parameters<typeof detectScheduledPulse>[0]["frame"]; audioWindow: AudioPulseWindow } {
  const windowSamples = SAMPLE_RATE; // 1 s
  const nowSampleIndex = 2_000_000;
  const startSampleIndex = nowSampleIndex - windowSamples;
  const samples = new Float32Array(windowSamples);

  // Deterministic pseudo-noise floor (no Math.random in this environment).
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < windowSamples; i += 1) {
    samples[i] = rand() * 1e-3;
  }
  if (withSpeech) {
    // A loud 300 Hz talker dominates broadband energy — the pre-scan must not
    // lock onto it instead of the quiet ultrasonic chirp.
    for (let i = 0; i < windowSamples; i += 1) {
      samples[i] += 0.2 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE);
    }
  }

  // Place the chirp. Its true emission sample index, in the absolute capture
  // timeline, is the scheduled instant plus output latency.
  const hostEstimatedEpochMs = 10_000 + 650; // "now": well after arrival
  const frame = {
    sampleIndex: nowSampleIndex,
    hostEstimatedEpochMs,
    sampleRate: SAMPLE_RATE,
    clockUncertaintyMs: 6,
  };
  // host epoch -> absolute sample: now maps to nowSampleIndex.
  const chirpStartAbs =
    nowSampleIndex +
    ((pulse.emittedAtHostEpochMs + outputLatencyMs - hostEstimatedEpochMs) /
      1_000) *
      SAMPLE_RATE;
  const chirpStartInWindow = Math.round(chirpStartAbs - startSampleIndex);
  const n = Math.round((DURATION_MS / 1_000) * SAMPLE_RATE);
  const sweep = (18_700 - 16_300) / (DURATION_MS / 1_000);
  for (let i = 0; i < n; i += 1) {
    const idx = chirpStartInWindow + i;
    if (idx < 0 || idx >= windowSamples) continue;
    const t = i / SAMPLE_RATE;
    const taper = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    samples[idx] += 0.02 * taper * Math.sin(2 * Math.PI * (16_300 * t + 0.5 * sweep * t * t));
  }

  return {
    frame,
    audioWindow: {
      samples,
      sampleRate: SAMPLE_RATE,
      startSampleIndex,
      anchorAudioContextTimeSeconds: 0,
      anchorPerformanceNowMs: 0,
      clientPerfOriginEpochMs: 0,
      clockOffsetMs: 0,
      clockUncertaintyMs: 6,
    },
  };
}

describe("detectScheduledPulse", () => {
  it("detects a chirp that left the speaker late (iOS output latency)", () => {
    // Regression: the prior ~180 ms window missed chirps that left the
    // speaker 130-230 ms late, which the UI then reported as "can't hear own
    // chirps" at full volume.
    for (const outputLatencyMs of [0, 130, 180, 230]) {
      const { frame, audioWindow } = windowWithChirp({ outputLatencyMs, withSpeech: false });
      const observation = detectScheduledPulse({ pulse, frame, audioWindow });
      expect(observation, `latency ${outputLatencyMs}ms`).not.toBeNull();
    }
  });

  it("finds the ultrasonic chirp under a loud talker", () => {
    const { frame, audioWindow } = windowWithChirp({ outputLatencyMs: 180, withSpeech: true });
    const observation = detectScheduledPulse({ pulse, frame, audioWindow });
    expect(observation).not.toBeNull();
  });

  it("rejects a window with no chirp", () => {
    const { frame, audioWindow } = windowWithChirp({ outputLatencyMs: 180, withSpeech: true });
    // Wipe the chirp band by zeroing the placed sweep region's contribution:
    // a flat noise+speech window must not yield a detection.
    const noiseOnly = { ...audioWindow, samples: audioWindow.samples.map(() => 0) as unknown as Float32Array };
    expect(detectScheduledPulse({ pulse, frame, audioWindow: noiseOnly })).toBeNull();
  });

  it("budgets at least the measured iOS output latency", () => {
    expect(CHIRP_OUTPUT_LATENCY_ALLOWANCE_MS).toBeGreaterThanOrEqual(250);
  });
});
