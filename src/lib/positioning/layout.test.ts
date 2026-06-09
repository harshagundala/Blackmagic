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
});
