import { describe, expect, test } from "vitest";
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
});

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
