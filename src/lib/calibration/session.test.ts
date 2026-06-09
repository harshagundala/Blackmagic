import { describe, expect, test } from "vitest";
import {
  createPairwiseCalibrationPlan,
  summarizePairwiseMeasurements,
  type PairwiseMeasurement,
} from "./session";

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
});
