import { describe, expect, it } from "vitest";
import { locateAudioSource } from "./source-locator";
import { pairKeyFor, type PairTdoaObservation } from "./pair-tdoa-history";
import type { PhonePoint } from "../positioning/layout";

const SPEED_OF_SOUND = 343;

function tdoaFor(
  source: PhonePoint,
  from: PhonePoint,
  to: PhonePoint,
  biasMs: number,
) {
  const dFrom = Math.hypot(source.x - from.x, source.y - from.y);
  const dTo = Math.hypot(source.x - to.x, source.y - to.y);
  return ((dTo - dFrom) / SPEED_OF_SOUND) * 1_000 + biasMs;
}

function buildScene(source: PhonePoint, noiseMs = 0) {
  const points: Record<string, PhonePoint> = {
    alpha: { x: 0, y: 0 },
    bravo: { x: 3.2, y: 0 },
    charlie: { x: 1.4, y: 2.6 },
  };
  const biases = new Map([
    [pairKeyFor("alpha", "bravo"), 5.5],
    [pairKeyFor("alpha", "charlie"), -8.2],
    [pairKeyFor("bravo", "charlie"), -13.7],
  ]);
  const ids = Object.keys(points).sort();
  const observations: PairTdoaObservation[] = [];
  let flip = 1;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = pairKeyFor(ids[i], ids[j]);
      flip = -flip;
      observations.push({
        pairKey: key,
        from: ids[i],
        to: ids[j],
        tdoaMs:
          tdoaFor(source, points[ids[i]], points[ids[j]], biases.get(key)!) +
          flip * noiseMs,
        weight: 0.85,
        atHostEpochMs: 1_000_000,
        eventId: "event-1",
      });
    }
  }
  return { points, biases, observations };
}

describe("locateAudioSource", () => {
  it("pinpoints the talker from bias-corrected event TDOAs", () => {
    const source = { x: 2.4, y: 1.1 };
    const { points, biases, observations } = buildScene(source);
    const hint = locateAudioSource({
      points,
      observations,
      biasMsForPair: (key) => biases.get(key) ?? null,
    });
    expect(hint).not.toBeNull();
    expect(Math.hypot(hint!.x - source.x, hint!.y - source.y)).toBeLessThan(0.2);
    expect(hint!.residualMs).toBeLessThan(0.2);
    expect(hint!.confidence).toBeGreaterThan(0.5);
  });

  it("tolerates measurement noise and reports the residual", () => {
    const source = { x: 0.6, y: 1.9 };
    const { points, biases, observations } = buildScene(source, 0.25);
    const hint = locateAudioSource({
      points,
      observations,
      biasMsForPair: (key) => biases.get(key) ?? null,
    });
    expect(hint).not.toBeNull();
    expect(Math.hypot(hint!.x - source.x, hint!.y - source.y)).toBeLessThan(0.6);
    expect(hint!.residualMs).toBeGreaterThan(0.02);
  });

  it("returns null without enough corrected pairs", () => {
    const source = { x: 2, y: 1 };
    const { points, observations } = buildScene(source);
    const hint = locateAudioSource({
      points,
      observations,
      // No calibrated bias for any pair yet.
      biasMsForPair: () => null,
    });
    expect(hint).toBeNull();
  });

  it("returns null for fewer than three devices", () => {
    const source = { x: 2, y: 1 };
    const { points, biases, observations } = buildScene(source);
    const twoDevicePoints = { alpha: points.alpha, bravo: points.bravo };
    const hint = locateAudioSource({
      points: twoDevicePoints,
      observations: observations.filter(
        (entry) => entry.pairKey === pairKeyFor("alpha", "bravo"),
      ),
      biasMsForPair: (key) => biases.get(key) ?? null,
    });
    expect(hint).toBeNull();
  });
});
