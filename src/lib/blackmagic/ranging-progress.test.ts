import { describe, expect, test } from "vitest";
import { describeRangingProgress } from "./ranging-progress";
import type { AcousticRange } from "../session/ranging";

describe("ranging progress narration", () => {
  test("stays silent while alone", () => {
    expect(
      describeRangingProgress({
        peerCount: 0,
        pulseCount: 3,
        observationCount: 1,
        ranges: [],
      }),
    ).toBeNull();
  });

  test("walks the pipeline stages", () => {
    expect(
      describeRangingProgress({
        peerCount: 1,
        pulseCount: 0,
        observationCount: 0,
        ranges: [],
      }),
    ).toBe("preparing chirps");
    expect(
      describeRangingProgress({
        peerCount: 1,
        pulseCount: 4,
        observationCount: 0,
        ranges: [],
      }),
    ).toBe("chirps 4 · listening");
    expect(
      describeRangingProgress({
        peerCount: 1,
        pulseCount: 4,
        observationCount: 3,
        ranges: [],
      }),
    ).toBe("chirps 4 · heard 3 · solving");
  });

  test("reports live links with the nearest distance", () => {
    expect(
      describeRangingProgress({
        peerCount: 2,
        pulseCount: 8,
        observationCount: 12,
        ranges: [makeRange(3.4), makeRange(1.25)],
      }),
    ).toBe("2 links · 1.3m");
  });
});

function makeRange(meters: number): AcousticRange {
  return {
    from: "a",
    to: "b",
    pulseId: "p",
    pulseIds: ["p"],
    samplesUsed: 1,
    meters,
    timingUncertaintyMs: 0.1,
    distanceUncertaintyMeters: 0.05,
    confidence: 0.8,
    observedAtHostEpochMs: 0,
  };
}
