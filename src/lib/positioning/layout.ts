export type PhonePoint = {
  x: number;
  y: number;
};

export type PairwiseDistance = {
  from: string;
  to: string;
  meters: number;
  weight?: number;
};

export type LayoutOptions = {
  anchorId?: string;
  iterations?: number;
  // Solved points from the previous frame, in the same anchor-centered frame.
  // The new solution is rotation/reflection-aligned to them so the layout
  // cannot mirror-flip or spin between frames, and small solver noise is
  // damped instead of rendered as jitter.
  previousPoints?: Record<string, PhonePoint> | null;
};

export type ConstellationLayout = {
  points: Record<string, PhonePoint>;
  quality: number;
  stress: number;
};

const DEFAULT_RADIUS_METERS = 1.4;
const GOLDEN_ANGLE_RADIANS = Math.PI * (3 - Math.sqrt(5));
const CONVERGENCE_CHECK_INTERVAL = 40;
const CONVERGENCE_RELATIVE_EPSILON = 0.001;
// Per-device movement below this is treated as solver noise and damped hard;
// movement beyond it is treated as a real position change and followed.
const JITTER_DAMPING_RADIUS_METERS = 0.35;
const MIN_DAMPING_FACTOR = 0.25;

export function estimateConstellation(
  participantIds: string[],
  distances: PairwiseDistance[],
  options: LayoutOptions = {},
): ConstellationLayout {
  const ids = orderedUnique(participantIds);
  const anchorId = options.anchorId && ids.includes(options.anchorId)
    ? options.anchorId
    : ids[0];

  if (ids.length === 0) {
    return { points: {}, quality: 0, stress: 0 };
  }

  if (distances.length === 0) {
    return radialFallback(ids, anchorId);
  }

  if (ids.length === 2) {
    return twoDeviceLayout(ids, distances, anchorId, options.previousPoints);
  }

  const points = initialPoints(ids, distances, anchorId);
  const iterations = options.iterations ?? 700;
  let lastCheckedStress = Number.POSITIVE_INFINITY;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const learningRate = 0.045 * (1 - iteration / iterations) + 0.004;

    for (const distance of distances) {
      const from = points[distance.from];
      const to = points[distance.to];
      if (!from || !to || distance.meters <= 0) {
        continue;
      }

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const current = Math.hypot(dx, dy) || 0.0001;
      const error = current - distance.meters;
      const weight = distance.weight ?? 1;
      const step = learningRate * weight * error;
      const ux = dx / current;
      const uy = dy / current;

      if (distance.from !== anchorId) {
        from.x += step * ux;
        from.y += step * uy;
      }

      if (distance.to !== anchorId) {
        to.x -= step * ux;
        to.y -= step * uy;
      }
    }

    normalizeToAnchor(points, anchorId);

    if (iteration > 0 && iteration % CONVERGENCE_CHECK_INTERVAL === 0) {
      const currentStress = pairwiseDistanceError(points, distances);
      if (
        lastCheckedStress - currentStress <
        lastCheckedStress * CONVERGENCE_RELATIVE_EPSILON
      ) {
        break;
      }
      lastCheckedStress = currentStress;
    }
  }

  stabilizeAgainstPrevious(points, options.previousPoints, anchorId);

  const stress = pairwiseDistanceError(points, distances);
  return {
    points: orderedPoints(ids, points),
    quality: 1 / (1 + stress * 1.8),
    stress,
  };
}

export function pairwiseDistanceError(
  points: Record<string, PhonePoint>,
  distances: PairwiseDistance[],
) {
  if (distances.length === 0) {
    return 0;
  }

  let weightedSquares = 0;
  let totalWeight = 0;

  for (const distance of distances) {
    const from = points[distance.from];
    const to = points[distance.to];
    if (!from || !to) {
      continue;
    }

    const weight = distance.weight ?? 1;
    const error = Math.hypot(to.x - from.x, to.y - from.y) - distance.meters;
    weightedSquares += error * error * weight;
    totalWeight += weight;
  }

  return totalWeight === 0 ? 0 : Math.sqrt(weightedSquares / totalWeight);
}

// Two devices define only a distance; the direction is unobservable. Place
// the peer deterministically (toward the previous frame's direction when one
// exists) so the rendered layout is stable instead of arbitrary.
function twoDeviceLayout(
  ids: string[],
  distances: PairwiseDistance[],
  anchorId: string,
  previousPoints: Record<string, PhonePoint> | null | undefined,
): ConstellationLayout {
  const peerId = ids.find((id) => id !== anchorId) ?? ids[0];
  const usable = distances.filter(
    (distance) =>
      distance.meters > 0 &&
      ((distance.from === anchorId && distance.to === peerId) ||
        (distance.from === peerId && distance.to === anchorId)),
  );
  if (usable.length === 0) {
    return radialFallback(ids, anchorId);
  }

  const totalWeight = usable.reduce(
    (sum, distance) => sum + Math.max(0.001, distance.weight ?? 1),
    0,
  );
  const meters =
    usable.reduce(
      (sum, distance) =>
        sum + distance.meters * Math.max(0.001, distance.weight ?? 1),
      0,
    ) / totalWeight;

  const previousPeer = previousPoints?.[peerId];
  const previousLength = previousPeer
    ? Math.hypot(previousPeer.x, previousPeer.y)
    : 0;
  const direction =
    previousPeer && previousLength > 0.001
      ? { x: previousPeer.x / previousLength, y: previousPeer.y / previousLength }
      : { x: 0, y: -1 };

  const points: Record<string, PhonePoint> = {
    [anchorId]: { x: 0, y: 0 },
    [peerId]: { x: direction.x * meters, y: direction.y * meters },
  };
  const stress = pairwiseDistanceError(points, distances);

  return {
    points: orderedPoints(ids, points),
    quality: 1 / (1 + stress * 1.8),
    stress,
  };
}

// Aligns the fresh solution onto the previous frame: pairwise distances are
// invariant under rotation and reflection, so we are free to pick the
// orientation closest to what the user is already looking at. A weighted
// 2D Procrustes fit (anchor pinned at the origin) chooses the rotation, a
// mirrored fit chooses whether to reflect, and adaptive damping suppresses
// residual solver noise without hiding real movement.
function stabilizeAgainstPrevious(
  points: Record<string, PhonePoint>,
  previousPoints: Record<string, PhonePoint> | null | undefined,
  anchorId: string,
) {
  if (!previousPoints) {
    return;
  }

  const sharedIds = Object.keys(points).filter(
    (id) =>
      id !== anchorId &&
      previousPoints[id] &&
      (Math.hypot(points[id].x, points[id].y) > 0.001 ||
        Math.hypot(previousPoints[id].x, previousPoints[id].y) > 0.001),
  );
  if (sharedIds.length === 0) {
    return;
  }

  const fitFor = (reflect: boolean) => {
    let dotSum = 0;
    let crossSum = 0;
    for (const id of sharedIds) {
      const current = reflect
        ? { x: points[id].x, y: -points[id].y }
        : points[id];
      const previous = previousPoints[id];
      dotSum += current.x * previous.x + current.y * previous.y;
      crossSum += current.x * previous.y - current.y * previous.x;
    }
    const angle = Math.atan2(crossSum, dotSum);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let error = 0;
    for (const id of sharedIds) {
      const current = reflect
        ? { x: points[id].x, y: -points[id].y }
        : points[id];
      const rotated = {
        x: current.x * cos - current.y * sin,
        y: current.x * sin + current.y * cos,
      };
      error += Math.hypot(
        rotated.x - previousPoints[id].x,
        rotated.y - previousPoints[id].y,
      );
    }
    return { reflect, cos, sin, error };
  };

  const direct = fitFor(false);
  const mirrored = fitFor(true);
  const chosen = mirrored.error < direct.error ? mirrored : direct;

  for (const id of Object.keys(points)) {
    if (id === anchorId) {
      continue;
    }
    const source = chosen.reflect
      ? { x: points[id].x, y: -points[id].y }
      : points[id];
    const aligned = {
      x: source.x * chosen.cos - source.y * chosen.sin,
      y: source.x * chosen.sin + source.y * chosen.cos,
    };
    const previous = previousPoints[id];
    if (!previous) {
      points[id] = aligned;
      continue;
    }
    const movement = Math.hypot(aligned.x - previous.x, aligned.y - previous.y);
    const damping = Math.max(
      MIN_DAMPING_FACTOR,
      Math.min(1, movement / JITTER_DAMPING_RADIUS_METERS),
    );
    points[id] = {
      x: previous.x + (aligned.x - previous.x) * damping,
      y: previous.y + (aligned.y - previous.y) * damping,
    };
  }
}

function radialFallback(ids: string[], anchorId: string): ConstellationLayout {
  const points: Record<string, PhonePoint> = {};
  const nonAnchors = ids.filter((id) => id !== anchorId);

  for (const id of ids) {
    if (id === anchorId) {
      points[id] = { x: 0, y: 0 };
      continue;
    }

    const index = nonAnchors.indexOf(id);
    const angle = -Math.PI / 2 + (index / Math.max(1, nonAnchors.length)) * Math.PI * 2;
    points[id] = {
      x: Math.cos(angle) * DEFAULT_RADIUS_METERS,
      y: Math.sin(angle) * DEFAULT_RADIUS_METERS,
    };
  }

  return {
    points: orderedPoints(ids, points),
    quality: 0.25,
    stress: 0,
  };
}

function initialPoints(
  ids: string[],
  distances: PairwiseDistance[],
  anchorId: string,
) {
  const points: Record<string, PhonePoint> = {};
  const anchorDistances = new Map<string, number>();

  for (const distance of distances) {
    if (distance.from === anchorId) {
      anchorDistances.set(distance.to, distance.meters);
    }
    if (distance.to === anchorId) {
      anchorDistances.set(distance.from, distance.meters);
    }
  }

  let nonAnchorIndex = 0;
  for (const id of ids) {
    if (id === anchorId) {
      points[id] = { x: 0, y: 0 };
      continue;
    }

    const radius = anchorDistances.get(id) ?? DEFAULT_RADIUS_METERS;
    const angle = -Math.PI / 2 + nonAnchorIndex * GOLDEN_ANGLE_RADIANS;
    points[id] = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
    nonAnchorIndex += 1;
  }

  return points;
}

function normalizeToAnchor(points: Record<string, PhonePoint>, anchorId: string) {
  const anchor = points[anchorId];
  if (!anchor) {
    return;
  }

  const offsetX = anchor.x;
  const offsetY = anchor.y;
  for (const point of Object.values(points)) {
    point.x -= offsetX;
    point.y -= offsetY;
  }
}

function orderedUnique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function orderedPoints(ids: string[], points: Record<string, PhonePoint>) {
  const ordered: Record<string, PhonePoint> = {};
  for (const id of ids) {
    ordered[id] = {
      x: round(points[id].x),
      y: round(points[id].y),
    };
  }
  return ordered;
}

function round(value: number) {
  return Number(value.toFixed(5));
}
