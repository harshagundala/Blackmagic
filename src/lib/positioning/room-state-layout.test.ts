import { describe, expect, test } from "vitest";
import {
  estimateRoomConstellation,
  rangeLayoutWeight,
} from "./room-state-layout";
import type { AcousticRange } from "@/lib/session/ranging";
import type { RoomState } from "@/lib/session/registry";

describe("room state constellation", () => {
  test("uses acoustic ranges before falling back to radial placement", () => {
    const room: RoomState = {
      sessionKey: "room",
      hostDeviceId: "host",
      updatedAt: 10_000,
      devices: [
        {
          deviceId: "host",
          joinedAt: 1_000,
          lastSeenAt: 10_000,
          role: "host",
          sessionKey: "room",
        },
        {
          deviceId: "phone-a",
          joinedAt: 1_500,
          lastSeenAt: 10_000,
          role: "phone",
          sessionKey: "room",
        },
      ],
      ranges: [
        {
          from: "host",
          to: "phone-a",
          pulseId: "pulse-1",
          pulseIds: ["pulse-1"],
          samplesUsed: 1,
          meters: 2.4,
          timingUncertaintyMs: 1.2,
          distanceUncertaintyMeters: 0.41,
          confidence: 0.82,
          observedAtHostEpochMs: 10_006,
        },
      ],
    };

    const layout = estimateRoomConstellation(room);

    expect(layout.layout.points.host).toEqual({ x: 0, y: 0 });
    expect(layout.layout.quality).toBeGreaterThan(0.25);
    expect(layout.devices).toEqual([
      expect.objectContaining({ deviceId: "host", role: "host", x: 0, y: 0 }),
      expect.objectContaining({
        deviceId: "phone-a",
        role: "phone",
        distanceMeters: 2.4,
        confidence: 0.467,
      }),
    ]);
  });

  test("weights repeated low-uncertainty ranges above one-shot uncertain ranges", () => {
    const stable = acousticRange({
      confidence: 0.7,
      distanceUncertaintyMeters: 0.2,
      samplesUsed: 5,
    });
    const oneShot = acousticRange({
      confidence: 0.82,
      distanceUncertaintyMeters: 1.8,
      samplesUsed: 1,
    });

    expect(rangeLayoutWeight(stable)).toBeGreaterThan(
      rangeLayoutWeight(oneShot),
    );
    expect(rangeLayoutWeight(oneShot)).toBeLessThan(0.45);
  });

  test("projects reconciled audio events toward the arrival leader side", () => {
    const room: RoomState = {
      sessionKey: "room",
      hostDeviceId: "host",
      updatedAt: 20_000,
      devices: [
        {
          deviceId: "host",
          joinedAt: 1_000,
          lastSeenAt: 20_000,
          role: "host",
          sessionKey: "room",
        },
        {
          deviceId: "phone-a",
          joinedAt: 1_500,
          lastSeenAt: 20_000,
          role: "phone",
          sessionKey: "room",
        },
      ],
      ranges: [
        {
          from: "host",
          to: "phone-a",
          pulseId: "pulse-1",
          pulseIds: ["pulse-1"],
          samplesUsed: 5,
          meters: 2,
          timingUncertaintyMs: 1,
          distanceUncertaintyMeters: 0.2,
          confidence: 0.86,
          observedAtHostEpochMs: 20_000,
        },
      ],
      audioEvents: [
        {
          id: "voice:18000:host",
          startedAtHostEpochMs: 18_000,
          endedAtHostEpochMs: 18_008,
          centerHostEpochMs: 18_004,
          timeSpreadMs: 8,
          arrivalLeaderDeviceId: "host",
          observedDeviceIds: ["host", "phone-a"],
          observations: [
            {
              deviceId: "host",
              eventId: "voice-host",
              detectedAtHostEpochMs: 18_000,
              sampleIndex: 960_000,
              sampleRate: 48_000,
              audioLevel: 0.09,
              confidence: 0.86,
              clockUncertaintyMs: 3,
            },
            {
              deviceId: "phone-a",
              eventId: "voice-phone-a",
              detectedAtHostEpochMs: 18_008,
              sampleIndex: 960_384,
              sampleRate: 48_000,
              audioLevel: 0.07,
              confidence: 0.78,
              clockUncertaintyMs: 4,
            },
          ],
          confidence: 0.76,
        },
      ],
    };

    const constellation = estimateRoomConstellation(room);
    const source = constellation.audioSources[0];
    const host = constellation.devices.find((device) => device.deviceId === "host");
    const phone = constellation.devices.find(
      (device) => device.deviceId === "phone-a",
    );

    expect(source).toEqual(
      expect.objectContaining({
        eventId: "voice:18000:host",
        ageMs: 1_996,
        arrivalLeaderDeviceId: "host",
        observedDeviceIds: ["host", "phone-a"],
        timeSpreadMs: 8,
      }),
    );
    expect(source.confidence).toBeGreaterThan(0.6);
    expect(host).toBeDefined();
    expect(phone).toBeDefined();
    expect(distance(source, host)).toBeLessThan(distance(source, phone));
    expect(distance(source, phone)).toBeGreaterThan(distance(host, phone));
  });
});

function acousticRange(
  overrides: Partial<AcousticRange> = {},
): AcousticRange {
  return {
    from: "host",
    to: "phone-a",
    pulseId: "pulse-1",
    pulseIds: ["pulse-1"],
    samplesUsed: 1,
    meters: 2.4,
    timingUncertaintyMs: 1.2,
    distanceUncertaintyMeters: 0.41,
    confidence: 0.82,
    observedAtHostEpochMs: 10_006,
    ...overrides,
  };
}

function distance(
  from: { x: number; y: number } | undefined,
  to: { x: number; y: number } | undefined,
) {
  if (!from || !to) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(to.x - from.x, to.y - from.y);
}
