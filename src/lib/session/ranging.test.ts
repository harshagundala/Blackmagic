import { describe, expect, test } from "vitest";
import { deriveAcousticRanges } from "./ranging";
import type { RoomDevice } from "./registry";

describe("acoustic room ranging", () => {
  test("turns matched pulse observations into pairwise meter estimates", () => {
    const devices: RoomDevice[] = [
      {
        deviceId: "host",
        joinedAt: 1_000,
        lastSeenAt: 2_000,
        role: "host",
        sessionKey: "room",
        acousticPulse: {
          id: "pulse-1",
          emittedAtHostEpochMs: 10_000,
          durationMs: 80,
          frequencyHz: 2_200,
        },
      },
      {
        deviceId: "phone-a",
        joinedAt: 1_100,
        lastSeenAt: 2_000,
        role: "phone",
        sessionKey: "room",
        acousticObservation: {
          pulseId: "pulse-1",
          detectedAtHostEpochMs: 10_006,
          amplitude: 0.34,
          confidence: 0.9,
          clockUncertaintyMs: 1.2,
        },
      },
    ];

    expect(deriveAcousticRanges(devices)).toEqual([
      expect.objectContaining({
        from: "host",
        to: "phone-a",
        pulseId: "pulse-1",
        meters: 2.06,
        confidence: expect.closeTo(0.795, 3),
        timingUncertaintyMs: 1.2,
        distanceUncertaintyMeters: 0.41,
      }),
    ]);
  });

  test("aggregates repeated pulse observations into one robust pairwise range", () => {
    const devices: RoomDevice[] = [
      {
        deviceId: "host",
        joinedAt: 1_000,
        lastSeenAt: 2_000,
        role: "host",
        sessionKey: "room",
        acousticPulses: [
          {
            id: "pulse-1",
            emittedAtHostEpochMs: 10_000,
            durationMs: 48,
            frequencyHz: 17_200,
            endFrequencyHz: 19_200,
          },
          {
            id: "pulse-2",
            emittedAtHostEpochMs: 11_000,
            durationMs: 48,
            frequencyHz: 17_200,
            endFrequencyHz: 19_200,
          },
          {
            id: "pulse-3",
            emittedAtHostEpochMs: 12_000,
            durationMs: 48,
            frequencyHz: 17_200,
            endFrequencyHz: 19_200,
          },
          {
            id: "pulse-outlier",
            emittedAtHostEpochMs: 13_000,
            durationMs: 48,
            frequencyHz: 17_200,
            endFrequencyHz: 19_200,
          },
        ],
      },
      {
        deviceId: "phone-a",
        joinedAt: 1_100,
        lastSeenAt: 2_000,
        role: "phone",
        sessionKey: "room",
        acousticObservations: [
          {
            pulseId: "pulse-1",
            detectedAtHostEpochMs: 10_006,
            amplitude: 0.3,
            confidence: 0.8,
            clockUncertaintyMs: 2,
          },
          {
            pulseId: "pulse-2",
            detectedAtHostEpochMs: 11_006.5,
            amplitude: 0.32,
            confidence: 0.9,
            clockUncertaintyMs: 2,
          },
          {
            pulseId: "pulse-3",
            detectedAtHostEpochMs: 12_007,
            amplitude: 0.31,
            confidence: 0.85,
            clockUncertaintyMs: 2,
          },
          {
            pulseId: "pulse-outlier",
            detectedAtHostEpochMs: 13_035,
            amplitude: 0.06,
            confidence: 0.15,
            clockUncertaintyMs: 8,
          },
        ],
      },
    ];

    expect(deriveAcousticRanges(devices)).toEqual([
      expect.objectContaining({
        from: "host",
        to: "phone-a",
        pulseId: "pulse-3",
        pulseIds: ["pulse-1", "pulse-2", "pulse-3"],
        samplesUsed: 3,
        meters: 2.24,
        timingUncertaintyMs: 2,
        distanceUncertaintyMeters: 0.69,
      }),
    ]);
    expect(deriveAcousticRanges(devices)[0].confidence).toBeGreaterThan(0.5);
  });

  test("rejects unmatched, negative, and implausibly late observations", () => {
    const devices: RoomDevice[] = [
      {
        deviceId: "host",
        joinedAt: 1_000,
        lastSeenAt: 2_000,
        role: "host",
        sessionKey: "room",
        acousticPulse: {
          id: "pulse-1",
          emittedAtHostEpochMs: 10_000,
          durationMs: 80,
          frequencyHz: 2_200,
        },
      },
      {
        deviceId: "early",
        joinedAt: 1_100,
        lastSeenAt: 2_000,
        role: "phone",
        sessionKey: "room",
        acousticObservation: {
          pulseId: "pulse-1",
          detectedAtHostEpochMs: 9_999,
          amplitude: 0.4,
          confidence: 1,
        },
      },
      {
        deviceId: "late",
        joinedAt: 1_200,
        lastSeenAt: 2_000,
        role: "phone",
        sessionKey: "room",
        acousticObservation: {
          pulseId: "pulse-1",
          detectedAtHostEpochMs: 10_090,
          amplitude: 0.4,
          confidence: 1,
        },
      },
      {
        deviceId: "wrong",
        joinedAt: 1_300,
        lastSeenAt: 2_000,
        role: "phone",
        sessionKey: "room",
        acousticObservation: {
          pulseId: "pulse-2",
          detectedAtHostEpochMs: 10_005,
          amplitude: 0.4,
          confidence: 1,
        },
      },
    ];

    expect(deriveAcousticRanges(devices)).toEqual([]);
  });
});
