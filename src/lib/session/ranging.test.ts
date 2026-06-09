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
