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
};

export type ConstellationLayout = {
  points: Record<string, PhonePoint>;
  quality: number;
  stress: number;
};

const DEFAULT_RADIUS_METERS = 1.4;
const GOLDEN_ANGLE_RADIANS = Math.PI * (3 - Math.sqrt(5));

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

  const points = initialPoints(ids, distances, anchorId);
  const iterations = options.iterations ?? 700;

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
  }

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
