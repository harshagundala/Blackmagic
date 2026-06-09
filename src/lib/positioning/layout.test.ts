import { describe, expect, test } from "vitest";
import {
  estimateConstellation,
  pairwiseDistanceError,
  type PairwiseDistance,
} from "./layout";

const distances: PairwiseDistance[] = [
  { from: "host", to: "north", meters: 2 },
  { from: "host", to: "east", meters: 2 },
  { from: "north", to: "east", meters: Math.sqrt(8) },
];

describe("relative phone layout", () => {
  test("anchors the host and preserves pairwise acoustic distances", () => {
    const layout = estimateConstellation(["host", "north", "east"], distances, {
      anchorId: "host",
      iterations: 900,
    });

    expect(layout.points.host.x).toBeCloseTo(0, 5);
    expect(layout.points.host.y).toBeCloseTo(0, 5);
    expect(pairwiseDistanceError(layout.points, distances)).toBeLessThan(0.08);
    expect(layout.quality).toBeGreaterThan(0.9);
  });

  test("falls back to a stable radial layout when pairwise distances are missing", () => {
    const layout = estimateConstellation(["host", "a", "b", "c"], [], {
      anchorId: "host",
    });

    expect(Object.keys(layout.points)).toEqual(["host", "a", "b", "c"]);
    expect(layout.points.host).toEqual({ x: 0, y: 0 });
    expect(layout.quality).toBeLessThan(0.5);
  });

  test("places a two-device room deterministically at the measured distance", () => {
    const layout = estimateConstellation(
      ["host", "phone-a"],
      [{ from: "host", to: "phone-a", meters: 2.6, weight: 0.9 }],
      { anchorId: "host" },
    );

    expect(layout.points.host).toEqual({ x: 0, y: 0 });
    expect(
      Math.hypot(layout.points["phone-a"].x, layout.points["phone-a"].y),
    ).toBeCloseTo(2.6, 3);
    // Deterministic direction with no history: straight ahead of the anchor.
    expect(layout.points["phone-a"].x).toBeCloseTo(0, 3);
    expect(layout.points["phone-a"].y).toBeCloseTo(-2.6, 3);
    expect(layout.quality).toBeGreaterThan(0.9);
  });

  test("keeps the two-device direction from the previous frame while updating distance", () => {
    const previous = estimateConstellation(
      ["host", "phone-a"],
      [{ from: "host", to: "phone-a", meters: 2 }],
      { anchorId: "host" },
    );
    const rotatedPrevious = {
      host: { x: 0, y: 0 },
      "phone-a": { x: Math.SQRT1_2 * 2, y: Math.SQRT1_2 * 2 },
    };

    const next = estimateConstellation(
      ["host", "phone-a"],
      [{ from: "host", to: "phone-a", meters: 3 }],
      { anchorId: "host", previousPoints: rotatedPrevious },
    );

    expect(previous.points["phone-a"].y).toBeCloseTo(-2, 3);
    expect(
      Math.hypot(next.points["phone-a"].x, next.points["phone-a"].y),
    ).toBeCloseTo(3, 3);
    // Direction follows the previous frame instead of resetting.
    expect(next.points["phone-a"].x).toBeCloseTo(Math.SQRT1_2 * 3, 2);
    expect(next.points["phone-a"].y).toBeCloseTo(Math.SQRT1_2 * 3, 2);
  });

  test("aligns to the previous frame so the constellation cannot mirror-flip", () => {
    const baseline = estimateConstellation(["host", "north", "east"], distances, {
      anchorId: "host",
      iterations: 900,
    });
    // A mirrored copy of the previous frame: a fresh solve has no reason to
    // match it unless temporal alignment chooses the reflection.
    const mirroredPrevious = Object.fromEntries(
      Object.entries(baseline.points).map(([id, point]) => [
        id,
        { x: -point.x, y: point.y },
      ]),
    );

    const aligned = estimateConstellation(["host", "north", "east"], distances, {
      anchorId: "host",
      iterations: 900,
      previousPoints: mirroredPrevious,
    });

    for (const id of ["north", "east"]) {
      const drift = Math.hypot(
        aligned.points[id].x - mirroredPrevious[id].x,
        aligned.points[id].y - mirroredPrevious[id].y,
      );
      expect(drift).toBeLessThan(0.15);
    }
    expect(pairwiseDistanceError(aligned.points, distances)).toBeLessThan(0.1);
  });

  test("damps sub-noise movement between frames", () => {
    const baseline = estimateConstellation(["host", "north", "east"], distances, {
      anchorId: "host",
      iterations: 900,
    });
    const nudged: PairwiseDistance[] = distances.map((distance) => ({
      ...distance,
      meters: distance.meters * 1.01,
    }));

    const next = estimateConstellation(["host", "north", "east"], nudged, {
      anchorId: "host",
      iterations: 900,
      previousPoints: baseline.points,
    });

    for (const id of ["north", "east"]) {
      const movement = Math.hypot(
        next.points[id].x - baseline.points[id].x,
        next.points[id].y - baseline.points[id].y,
      );
      // A 1% range wobble must not translate into a visible jump.
      expect(movement).toBeLessThan(0.05);
    }
  });
});
