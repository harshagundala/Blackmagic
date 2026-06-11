// Locates the in-room sound source (the talker) for a single voice event,
// once three or more devices have a solved layout and calibrated per-pair
// offsets. Each bias-corrected pair TDOA constrains the source to a
// hyperbola; a multi-resolution grid search over the room followed by local
// refinement finds the weighted least-squares intersection. Grid-first keeps
// the solver immune to the local minima that plague gradient descent on
// hyperbolic residuals near the array.

import type { PhonePoint } from "../positioning/layout";
import type { PairTdoaObservation } from "./pair-tdoa-history";

export type SourceHint = {
  x: number;
  y: number;
  residualMs: number;
  confidence: number;
  atHostEpochMs: number;
  eventId: string;
  pairsUsed: number;
};

export type LocateAudioSourceInput = {
  points: Record<string, PhonePoint>;
  observations: PairTdoaObservation[];
  // Calibrated nuisance offset for a pair (from PairRangeEstimate.biasMs);
  // null while the pair is still converging.
  biasMsForPair: (pairKey: string) => number | null;
  speedOfSoundMetersPerSecond?: number;
  padMeters?: number;
};

const SPEED_OF_SOUND_METERS_PER_SECOND = 343;
const PAD_METERS = 3;
const COARSE_STEPS = 28;
const REFINE_LEVELS = 3;

export function locateAudioSource({
  points,
  observations,
  biasMsForPair,
  speedOfSoundMetersPerSecond = SPEED_OF_SOUND_METERS_PER_SECOND,
  padMeters = PAD_METERS,
}: LocateAudioSourceInput): SourceHint | null {
  const constraints = observations
    .map((observation) => {
      const from = points[observation.from];
      const to = points[observation.to];
      const biasMs = biasMsForPair(observation.pairKey);
      if (!from || !to || biasMs === null || !(observation.weight > 0)) {
        return null;
      }
      return {
        from,
        to,
        correctedMs: observation.tdoaMs - biasMs,
        weight: observation.weight,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const devicesUsed = new Set(
    observations
      .filter((observation) => biasMsForPair(observation.pairKey) !== null)
      .flatMap((observation) => [observation.from, observation.to])
      .filter((deviceId) => points[deviceId]),
  );
  if (constraints.length < 2 || devicesUsed.size < 3) {
    return null;
  }

  const xs = Object.values(points).map((point) => point.x);
  const ys = Object.values(points).map((point) => point.y);
  const bounds = {
    minX: Math.min(...xs) - padMeters,
    maxX: Math.max(...xs) + padMeters,
    minY: Math.min(...ys) - padMeters,
    maxY: Math.max(...ys) + padMeters,
  };

  const cost = (x: number, y: number) => {
    let total = 0;
    let weightTotal = 0;
    for (const constraint of constraints) {
      const predictedMs =
        ((Math.hypot(x - constraint.to.x, y - constraint.to.y) -
          Math.hypot(x - constraint.from.x, y - constraint.from.y)) /
          speedOfSoundMetersPerSecond) *
        1_000;
      const errorMs = constraint.correctedMs - predictedMs;
      total += constraint.weight * errorMs * errorMs;
      weightTotal += constraint.weight;
    }
    return weightTotal > 0 ? total / weightTotal : Number.POSITIVE_INFINITY;
  };

  let best = { x: 0, y: 0, cost: Number.POSITIVE_INFINITY };
  const stepX = (bounds.maxX - bounds.minX) / COARSE_STEPS;
  const stepY = (bounds.maxY - bounds.minY) / COARSE_STEPS;
  for (let ix = 0; ix <= COARSE_STEPS; ix += 1) {
    for (let iy = 0; iy <= COARSE_STEPS; iy += 1) {
      const x = bounds.minX + ix * stepX;
      const y = bounds.minY + iy * stepY;
      const value = cost(x, y);
      if (value < best.cost) {
        best = { x, y, cost: value };
      }
    }
  }

  let radius = Math.max(stepX, stepY);
  for (let level = 0; level < REFINE_LEVELS; level += 1) {
    const step = radius / 4;
    for (let ix = -4; ix <= 4; ix += 1) {
      for (let iy = -4; iy <= 4; iy += 1) {
        const x = best.x + ix * step;
        const y = best.y + iy * step;
        const value = cost(x, y);
        if (value < best.cost) {
          best = { x, y, cost: value };
        }
      }
    }
    radius = step;
  }

  const residualMs = Math.sqrt(best.cost);
  const meanWeight =
    constraints.reduce((total, entry) => total + entry.weight, 0) /
    constraints.length;
  const confidence = clamp01(
    meanWeight *
      (1 / (1 + residualMs / 0.8)) *
      Math.min(1, constraints.length / 3),
  );

  return {
    x: round(best.x, 3),
    y: round(best.y, 3),
    residualMs: round(residualMs, 3),
    confidence: round(confidence, 3),
    atHostEpochMs: Math.max(
      ...observations.map((observation) => observation.atHostEpochMs),
    ),
    eventId: observations[0].eventId,
    pairsUsed: constraints.length,
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, decimals: number) {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Number(value.toFixed(decimals));
}
