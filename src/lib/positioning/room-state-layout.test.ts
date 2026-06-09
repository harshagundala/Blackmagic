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
