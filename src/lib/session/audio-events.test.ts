import { describe, expect, test } from "vitest";
import { captureAudioSnippet } from "../acoustics/audio-snippet";
import {
  deriveReconciledAudioEvents,
  type VoiceActivityEvent,
} from "./audio-events";

describe("audio event reconciliation", () => {
  test("clusters near-simultaneous voice events across devices", () => {
    const events = deriveReconciledAudioEvents([
      {
        deviceId: "host",
        voiceEvents: [
          voiceEvent({
            id: "host-1",
            detectedAtHostEpochMs: 10_000,
            confidence: 0.84,
            clockUncertaintyMs: 3,
          }),
        ],
      },
      {
        deviceId: "phone-a",
        voiceEvents: [
          voiceEvent({
            id: "phone-a-1",
            detectedAtHostEpochMs: 10_007,
            confidence: 0.76,
            clockUncertaintyMs: 4,
          }),
        ],
      },
      {
        deviceId: "phone-b",
        voiceEvents: [
          voiceEvent({
            id: "phone-b-1",
            detectedAtHostEpochMs: 10_190,
            confidence: 0.72,
            clockUncertaintyMs: 5,
          }),
        ],
      },
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        id: "voice:10000:host-1",
        startedAtHostEpochMs: 10_000,
        endedAtHostEpochMs: 10_007,
        timeSpreadMs: 7,
        arrivalLeaderDeviceId: "host",
        observedDeviceIds: ["host", "phone-a"],
        confidence: expect.any(Number),
      }),
      expect.objectContaining({
        startedAtHostEpochMs: 10_190,
        observedDeviceIds: ["phone-b"],
      }),
    ]);
    expect(events[0].confidence).toBeGreaterThan(0.7);
  });

  test("preserves per-device timestamp quality in reconciled audio events", () => {
    const events = deriveReconciledAudioEvents([
      {
        deviceId: "host",
        voiceEvents: [
          voiceEvent({
            id: "host-1",
            detectedAtHostEpochMs: 30_000,
            confidence: 0.9,
            clockUncertaintyMs: 2,
            clockMaxErrorMs: 2.4,
            clockBestRoundTripMs: 4,
            clockJitterMs: 0.2,
            clockSamplesUsed: 12,
            clockOutliersRejected: 1,
            clockOffsetStabilityMs: 0.2,
            timingConfidence: 0.91,
          }),
        ],
      },
      {
        deviceId: "phone-a",
        voiceEvents: [
          voiceEvent({
            id: "phone-a-1",
            detectedAtHostEpochMs: 30_006,
            confidence: 0.82,
            clockUncertaintyMs: 18,
            clockMaxErrorMs: 18,
            clockBestRoundTripMs: 35,
            clockJitterMs: 4,
            clockSamplesUsed: 4,
            clockOutliersRejected: 3,
            clockOffsetStabilityMs: 4,
            timingConfidence: 0.34,
          }),
        ],
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        timestampUncertaintyMs: 18,
        timingConfidence: expect.any(Number),
      }),
    );
    expect(events[0].timingConfidence).toBeLessThan(0.7);
    expect(events[0].observations[0]).toEqual(
      expect.objectContaining({
        deviceId: "host",
        clockMaxErrorMs: 2.4,
        clockBestRoundTripMs: 4,
        clockJitterMs: 0.2,
        clockSamplesUsed: 12,
        clockOutliersRejected: 1,
        clockOffsetStabilityMs: 0.2,
        timingConfidence: 0.91,
      }),
    );
  });

  test("preserves motion stability beside each audio observation", () => {
    const events = deriveReconciledAudioEvents([
      {
        deviceId: "host",
        voiceEvents: [
          {
            ...voiceEvent({
              id: "host-motion",
              detectedAtHostEpochMs: 40_000,
            }),
            motionStability: 0.93,
          },
        ],
      },
      {
        deviceId: "phone-a",
        voiceEvents: [
          {
            ...voiceEvent({
              id: "phone-motion",
              detectedAtHostEpochMs: 40_006,
            }),
            motionStability: 0.21,
          },
        ],
      },
    ]);

    expect(events[0].observations).toEqual([
      expect.objectContaining({
        deviceId: "host",
        motionStability: 0.93,
      }),
      expect.objectContaining({
        deviceId: "phone-a",
        motionStability: 0.21,
      }),
    ]);
  });

  test("refines observation timing from matching audio fingerprints", () => {
    const events = deriveReconciledAudioEvents([
      {
        deviceId: "host",
        voiceEvents: [
          voiceEvent({
            id: "host-fingerprint",
            detectedAtHostEpochMs: 50_000,
            audioFingerprint: {
              sampleRate: 1_000,
              startSampleIndex: 0,
              centerSampleIndex: 200,
              hopMs: 5,
              windowMs: 80,
              values: [0, 0.1, 0.35, 1, 0.7, 0.28, 0.1, 0],
            },
          }),
        ],
      },
      {
        deviceId: "phone-a",
        voiceEvents: [
          voiceEvent({
            id: "phone-fingerprint",
            detectedAtHostEpochMs: 50_020,
            audioFingerprint: {
              sampleRate: 1_000,
              startSampleIndex: 0,
              centerSampleIndex: 200,
              hopMs: 5,
              windowMs: 80,
              values: [0, 0, 0, 0.1, 0.35, 1, 0.7, 0.28],
            },
          }),
        ],
      },
    ]);

    expect(events[0]).toEqual(
      expect.objectContaining({
        timeSpreadMs: 10,
        fingerprintAlignmentConfidence: expect.any(Number),
      }),
    );
    expect(events[0].fingerprintAlignmentConfidence).toBeGreaterThan(0.8);
    expect(events[0].observations[1]).toEqual(
      expect.objectContaining({
        deviceId: "phone-a",
        fingerprintOffsetMs: 10,
        refinedDetectedAtHostEpochMs: 50_010,
        fingerprintCorrelation: expect.any(Number),
      }),
    );
  });

  test("uses fingerprints to bridge clock-skewed observations outside the nominal cluster window", () => {
    const events = deriveReconciledAudioEvents([
      {
        deviceId: "host",
        voiceEvents: [
          voiceEvent({
            id: "host-skew-bridge",
            detectedAtHostEpochMs: 60_000,
            clockUncertaintyMs: 3,
            clockMaxErrorMs: 3,
            audioFingerprint: {
              sampleRate: 1_000,
              startSampleIndex: 0,
              centerSampleIndex: 200,
              hopMs: 5,
              windowMs: 80,
              values: [0, 0.1, 0.35, 1, 0.7, 0.28, 0.1, 0],
            },
          }),
        ],
      },
      {
        deviceId: "phone-a",
        voiceEvents: [
          voiceEvent({
            id: "phone-skew-bridge",
            detectedAtHostEpochMs: 60_150,
            clockUncertaintyMs: 180,
            clockMaxErrorMs: 180,
            clockBestRoundTripMs: 260,
            clockJitterMs: 18,
            clockSamplesUsed: 2,
            clockOffsetStabilityMs: 20,
            timingConfidence: 0.08,
            audioFingerprint: {
              sampleRate: 1_000,
              startSampleIndex: 0,
              centerSampleIndex: 200,
              hopMs: 5,
              windowMs: 80,
              values: [0, 0, 0, 0.1, 0.35, 1, 0.7, 0.28],
            },
          }),
        ],
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        observedDeviceIds: ["host", "phone-a"],
        timeSpreadMs: 10,
        timestampUncertaintyMs: 180,
      }),
    );
    expect(events[0].observations[1]).toEqual(
      expect.objectContaining({
        deviceId: "phone-a",
        fingerprintOffsetMs: 10,
        refinedDetectedAtHostEpochMs: 60_010,
      }),
    );
  });
  test("raw-audio GCC-PHAT alignment supersedes fingerprint and clock timing", () => {
    const trueDelayMs = 6.5;
    const { referenceSnippet, delayedSnippet } = snippetPair(trueDelayMs);
    const coarseFingerprint = {
      sampleRate: 1_000,
      startSampleIndex: 0,
      centerSampleIndex: 200,
      hopMs: 5,
      windowMs: 80,
      values: [0, 0.1, 0.35, 1, 0.7, 0.28, 0.1, 0],
    };

    const events = deriveReconciledAudioEvents([
      {
        deviceId: "host",
        voiceEvents: [
          voiceEvent({
            id: "host-raw",
            detectedAtHostEpochMs: 70_000,
            audioFingerprint: coarseFingerprint,
            audioSnippet: referenceSnippet,
          }),
        ],
      },
      {
        deviceId: "phone-a",
        voiceEvents: [
          voiceEvent({
            id: "phone-raw",
            // Host-clock estimate is 40 ms wrong; raw audio must correct it.
            detectedAtHostEpochMs: 70_040,
            clockUncertaintyMs: 60,
            clockMaxErrorMs: 60,
            audioFingerprint: { ...coarseFingerprint },
            audioSnippet: delayedSnippet,
          }),
        ],
      },
    ]);

    expect(events).toHaveLength(1);
    const phone = events[0].observations.find(
      (observation) => observation.deviceId === "phone-a",
    );
    expect(phone?.rawAudioCorrelation).toBeGreaterThan(0.42);
    expect(phone?.rawAudioOffsetMs).toBeCloseTo(trueDelayMs, 0);
    expect(phone?.refinedDetectedAtHostEpochMs).toBeCloseTo(
      70_000 + trueDelayMs,
      0,
    );
    expect(events[0].rawAudioAlignmentConfidence).toBeGreaterThan(0.42);
  });
});

const SNIPPET_SOURCE_RATE = 48_000;

function snippetPair(delayMs: number) {
  const delaySamples = (delayMs / 1_000) * SNIPPET_SOURCE_RATE;
  const source = speechLikeSignal(SNIPPET_SOURCE_RATE, 31);
  const referenceSnippet = captureAudioSnippet({
    samples: roomCapture(source, 0, 11),
    sampleRate: SNIPPET_SOURCE_RATE,
    startSampleIndex: 0,
    centerSampleIndex: 24_000,
  });
  const delayedSnippet = captureAudioSnippet({
    samples: roomCapture(source, delaySamples, 22),
    sampleRate: SNIPPET_SOURCE_RATE,
    startSampleIndex: 0,
    centerSampleIndex: 24_000,
  });
  if (!referenceSnippet || !delayedSnippet) {
    throw new Error("test snippet synthesis failed");
  }
  return { referenceSnippet, delayedSnippet };
}

function speechLikeSignal(lengthSamples: number, seed: number) {
  const random = mulberry32(seed);
  const raw = new Float32Array(lengthSamples);
  for (let index = 0; index < lengthSamples; index += 1) {
    raw[index] = random() * 2 - 1;
  }
  const smoothed = movingAverage(raw, 16);
  const wide = movingAverage(raw, 160);
  const band = new Float32Array(lengthSamples);
  for (let index = 0; index < lengthSamples; index += 1) {
    const envelope =
      0.4 +
      0.6 *
        Math.abs(Math.sin((2 * Math.PI * 4 * index) / SNIPPET_SOURCE_RATE));
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

function roomCapture(
  source: Float32Array,
  delaySamples: number,
  noiseSeed: number,
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
      0.35 * readAt(index - delaySamples - 220) +
      (random() * 2 - 1) * 0.02;
  }
  return output;
}

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

function voiceEvent(
  overrides: Partial<VoiceActivityEvent> = {},
): VoiceActivityEvent {
  return {
    id: "event-1",
    detectedAtHostEpochMs: 10_000,
    audioContextTimeSeconds: 12.5,
    sampleIndex: 600_000,
    sampleRate: 48_000,
    audioLevel: 0.08,
    confidence: 0.8,
    clockOffsetMs: 2,
    clockUncertaintyMs: 3,
    clockQuality: 0.96,
    clockMaxErrorMs: 3,
    clockBestRoundTripMs: 6,
    clockJitterMs: 0.3,
    clockSamplesUsed: 8,
    clockOutliersRejected: 0,
    clockOffsetStabilityMs: 0.3,
    timingConfidence: 0.84,
    ...overrides,
  };
}
