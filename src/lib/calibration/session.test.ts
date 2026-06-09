import { describe, expect, test } from "vitest";
import {
  createPairwiseCalibrationPlan,
  selectObservablePulse,
  selectUpcomingCalibrationTurn,
  summarizePairwiseMeasurements,
  type PairwiseMeasurement,
} from "./session";
import type { RoomDevice } from "@/lib/session/registry";

describe("pairwise calibration session", () => {
  test("creates non-overlapping chirp slots for every phone pair", () => {
    const plan = createPairwiseCalibrationPlan(["host", "a", "b"], {
      chirpsPerPair: 3,
      slotDurationMs: 320,
      guardMs: 80,
    });

    expect(plan.pairs).toEqual([
      { from: "host", to: "a" },
      { from: "host", to: "b" },
      { from: "a", to: "b" },
    ]);
    expect(plan.slots).toHaveLength(9);
    expect(plan.slots[1].startsAtMs - plan.slots[0].startsAtMs).toBe(400);
    expect(plan.durationMs).toBe(3_600);
  });

  test("uses the median measurement and downweights noisy ranges", () => {
    const measurements: PairwiseMeasurement[] = [
      { from: "host", to: "a", meters: 1.02, confidence: 0.9 },
      { from: "a", to: "host", meters: 1.07, confidence: 0.9 },
      { from: "host", to: "a", meters: 3.6, confidence: 0.1 },
      { from: "host", to: "b", meters: 2.3, confidence: 0.6 },
      { from: "host", to: "b", meters: 2.1, confidence: 0.6 },
    ];

    const ranges = summarizePairwiseMeasurements(measurements);

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({
      from: "host",
      to: "a",
      meters: 1.07,
    });
    expect(ranges[0].weight).toBeGreaterThan(ranges[1].weight ?? 0);
  });

  test("selects a deterministic future emitter turn for all devices", () => {
    const options = {
      slotDurationMs: 1_000,
      pulseOffsetMs: 600,
      minLeadMs: 250,
      pulseDurationMs: 40,
    };

    expect(
      selectUpcomingCalibrationTurn(["host", "a", "b"], 100, options),
    ).toEqual({
      emitterId: "host",
      sequence: 0,
      slotStartsAtHostEpochMs: 0,
      pulseEmittedAtHostEpochMs: 600,
      pulseDurationMs: 40,
    });

    expect(
      selectUpcomingCalibrationTurn(["host", "a", "b"], 400, options),
    ).toEqual(
      expect.objectContaining({
        emitterId: "a",
        sequence: 1,
        pulseEmittedAtHostEpochMs: 1_600,
      }),
    );

    expect(selectUpcomingCalibrationTurn(["host"], 100, options)).toBeNull();
  });

  test("chooses the closest pulse that should be observed, including self chirps", () => {
    const devices: RoomDevice[] = [
      deviceWithPulse("host", "host:old", 8_800),
      deviceWithPulse("phone-a", "phone-a:self", 10_200),
      deviceWithPulse("phone-b", "phone-b:near", 10_900),
      deviceWithPulse("phone-c", "phone-c:future", 16_000),
    ];

    expect(
      selectObservablePulse(devices, "phone-a", 10_000, {
        maxFutureMs: 1_500,
        maxLateMs: 200,
      }),
    ).toEqual(
      expect.objectContaining({
        id: "phone-a:self",
        emittedAtHostEpochMs: 10_200,
      }),
    );
  });
});

function deviceWithPulse(
  deviceId: string,
  pulseId: string,
  emittedAtHostEpochMs: number,
): RoomDevice {
  return {
    deviceId,
    joinedAt: 1_000,
    lastSeenAt: 2_000,
    role: deviceId === "host" ? "host" : "phone",
    sessionKey: "room",
    acousticPulse: {
      id: pulseId,
      emittedAtHostEpochMs,
      durationMs: 48,
      frequencyHz: 17_200,
      endFrequencyHz: 19_200,
    },
  };
}
