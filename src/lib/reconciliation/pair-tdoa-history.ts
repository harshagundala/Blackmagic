// Per-pair accumulator for passive TDOA observations of ambient sound.
//
// Each observation is the arrival-time difference of one voice event between
// two devices, measured in the host clock domain:
//
//   tdoaMs = (d_to − d_from)/c · 1000 + Δ(t)
//
// where Δ(t) is a per-pair nuisance offset (residual clock-sync error plus
// the un-observable audio input latency difference) drifting slowly with the
// ADC sample-rate offset. As the talker moves, the geometric term sweeps
// [−d/c, +d/c] while Δ stays affine in time, so after a robust drift fit the
// spread of the de-drifted TDOAs yields the inter-device distance and their
// midpoint yields Δ — the distance estimate does not inherit the clock-sync
// error (extreme-TDOA method, Hon/Wang et al., IEEE TASLP 2015).
//
// Physical limit worth remembering: the distance converges from below. A
// talker that never approaches the pair's endfire line yields a genuine
// lower bound, and no single-pair statistic can detect that (a broadside-only
// sweep of a far pair is distribution-identical to a full sweep of a near
// pair). `coverage` therefore measures convergence quality of the estimate,
// not endfire coverage; layout stress across 3+ devices is what exposes
// under-estimated pairs.

export type PairTdoaObservation = {
  pairKey: string;
  // Lexically smaller device id; tdoaMs is positive when `to` heard the
  // sound after `from`.
  from: string;
  to: string;
  tdoaMs: number;
  // Quality weight in (0, 1], from GCC-PHAT peak shape and event confidence.
  weight: number;
  atHostEpochMs: number;
  eventId: string;
};

export type PairTdoaHistory = {
  // Sorted by atHostEpochMs ascending, unique per eventId.
  observations: PairTdoaObservation[];
  // Consecutive median-gate rejections that agreed with EACH OTHER: the
  // signature of a capture restart (the sample-domain origin jumped), not of
  // stray reverberation. After enough agreement the history re-seeds on the
  // new regime instead of rejecting forever.
  rejectedStreak?: number;
  lastRejectedTdoaMs?: number | null;
};

export type PairRangeEstimate = {
  from: string;
  to: string;
  meters: number;
  uncertaintyMeters: number;
  // Estimated nuisance offset Δ at `nowHostEpochMs`; what an active
  // round-trip chirp would calibrate directly.
  biasMs: number;
  driftMsPerSecond: number;
  // Convergence quality in [0, 1]: evidence density at both extremes and
  // span stability over the window. Not a guarantee the talker reached
  // endfire — the estimate remains a lower bound on the true distance.
  coverage: number;
  samplesUsed: number;
  confidence: number;
  observedAtHostEpochMs: number;
};

export type PairHistoryOptions = {
  maxObservations?: number;
  maxAgeMs?: number;
  // Reject observations this far from the settled median; generous enough
  // for any in-room geometry (10 m ≈ 29 ms) plus offset wander.
  maxMedianDeviationMs?: number;
};

export type PairRangeOptions = {
  windowMs?: number;
  minSamples?: number;
  speedOfSoundMetersPerSecond?: number;
  lowQuantile?: number;
  highQuantile?: number;
  maxDriftMsPerSecond?: number;
};

const SPEED_OF_SOUND_METERS_PER_SECOND = 343;
const MAX_OBSERVATIONS = 160;
const MAX_AGE_MS = 180_000;
const MAX_MEDIAN_DEVIATION_MS = 40;
const MEDIAN_GATE_MIN_SAMPLES = 12;
const REGIME_JUMP_STREAK = 4;
const REGIME_AGREEMENT_MS = 40;
const RANGE_WINDOW_MS = 150_000;
export const MIN_RANGE_SAMPLES = 5;
const LOW_QUANTILE = 0.06;
const HIGH_QUANTILE = 0.94;
// Physical ADC sample-rate offsets sit within ~50 ppm; clamping keeps a
// monotonically walking talker from being mistaken for clock drift.
const MAX_DRIFT_MS_PER_SECOND = 0.05;
const MIN_DRIFT_PAIR_SPACING_MS = 20_000;
const MAD_TO_SIGMA = 1.4826;

export function pairKeyFor(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function createPairTdoaHistory(): PairTdoaHistory {
  return { observations: [] };
}

export function recordPairTdoaObservation(
  history: PairTdoaHistory,
  observation: PairTdoaObservation,
  {
    maxObservations = MAX_OBSERVATIONS,
    maxAgeMs = MAX_AGE_MS,
    maxMedianDeviationMs = MAX_MEDIAN_DEVIATION_MS,
  }: PairHistoryOptions = {},
): PairTdoaHistory {
  if (
    !Number.isFinite(observation.tdoaMs) ||
    !Number.isFinite(observation.atHostEpochMs) ||
    !(observation.weight > 0)
  ) {
    return history;
  }

  const settled = history.observations.length >= MEDIAN_GATE_MIN_SAMPLES;
  if (settled) {
    const median = weightedQuantile(
      history.observations.map((entry) => ({
        value: entry.tdoaMs,
        weight: entry.weight,
      })),
      0.5,
    );
    if (median !== null && Math.abs(observation.tdoaMs - median) > maxMedianDeviationMs) {
      const agreesWithLastRejection =
        typeof history.lastRejectedTdoaMs === "number" &&
        Math.abs(observation.tdoaMs - history.lastRejectedTdoaMs) <=
          REGIME_AGREEMENT_MS;
      const rejectedStreak = agreesWithLastRejection
        ? (history.rejectedStreak ?? 0) + 1
        : 1;
      if (rejectedStreak >= REGIME_JUMP_STREAK) {
        // The world really did change (capture restart / origin jump):
        // start over on the new regime.
        return { observations: [observation] };
      }
      return {
        ...history,
        rejectedStreak,
        lastRejectedTdoaMs: observation.tdoaMs,
      };
    }
  }

  const observations = history.observations
    .filter((entry) => entry.eventId !== observation.eventId)
    .concat(observation)
    .sort((a, b) => a.atHostEpochMs - b.atHostEpochMs);

  const newestMs = observations[observations.length - 1].atHostEpochMs;
  const pruned = observations.filter(
    (entry) => newestMs - entry.atHostEpochMs <= maxAgeMs,
  );
  return {
    observations: pruned.slice(Math.max(0, pruned.length - maxObservations)),
  };
}

export function removePairObservationsNear(
  history: PairTdoaHistory,
  hostEpochMs: number,
  radiusMs: number,
): PairTdoaHistory {
  return {
    ...history,
    observations: history.observations.filter(
      (entry) => Math.abs(entry.atHostEpochMs - hostEpochMs) > radiusMs,
    ),
  };
}

export function clearPairHistoriesForDevice(
  histories: Map<string, PairTdoaHistory>,
  deviceId: string,
) {
  for (const key of [...histories.keys()]) {
    const [from, to] = key.split("|");
    if (from === deviceId || to === deviceId) {
      histories.delete(key);
    }
  }
}

export function derivePairRangeEstimate(
  history: PairTdoaHistory,
  nowHostEpochMs: number,
  {
    windowMs = RANGE_WINDOW_MS,
    minSamples = MIN_RANGE_SAMPLES,
    speedOfSoundMetersPerSecond = SPEED_OF_SOUND_METERS_PER_SECOND,
    lowQuantile = LOW_QUANTILE,
    highQuantile = HIGH_QUANTILE,
    maxDriftMsPerSecond = MAX_DRIFT_MS_PER_SECOND,
  }: PairRangeOptions = {},
): PairRangeEstimate | null {
  const windowed = history.observations.filter(
    (entry) => nowHostEpochMs - entry.atHostEpochMs <= windowMs,
  );
  if (windowed.length < minSamples) {
    return null;
  }

  const driftMsPerSecond = estimateDriftMsPerSecond(
    windowed,
    maxDriftMsPerSecond,
  );
  const centerEpochMs =
    windowed.reduce((total, entry) => total + entry.atHostEpochMs, 0) /
    windowed.length;
  const deDrifted = windowed.map((entry) => ({
    value:
      entry.tdoaMs -
      (driftMsPerSecond * (entry.atHostEpochMs - centerEpochMs)) / 1_000,
    weight: entry.weight,
    atHostEpochMs: entry.atHostEpochMs,
  }));

  // Clip stray reverberant matches; the floor keeps a genuinely tight
  // distribution (close pair, quiet room) from clipping its own physics.
  const median = weightedQuantile(deDrifted, 0.5);
  if (median === null) {
    return null;
  }
  const mad = weightedQuantile(
    deDrifted.map((entry) => ({
      value: Math.abs(entry.value - median),
      weight: entry.weight,
    })),
    0.5,
  );
  const clipMs = Math.max(4 * MAD_TO_SIGMA * (mad ?? 0), 2);
  const inliers = deDrifted.filter(
    (entry) => Math.abs(entry.value - median) <= clipMs,
  );
  // Clipping an outlier must not retract an estimate the un-clipped buffer
  // was allowed to make: require a floor below minSamples, not minSamples
  // itself, or the range flickers in and out at the boundary.
  if (inliers.length < Math.max(4, minSamples - 2)) {
    return null;
  }

  const low = weightedQuantile(inliers, lowQuantile);
  const high = weightedQuantile(inliers, highQuantile);
  if (low === null || high === null || high < low) {
    return null;
  }

  const halfSpanMs = (high - low) / 2;
  const meters = (halfSpanMs / 1_000) * speedOfSoundMetersPerSecond;
  const biasAtCenterMs = (high + low) / 2;
  const biasMs =
    biasAtCenterMs + (driftMsPerSecond * (nowHostEpochMs - centerEpochMs)) / 1_000;

  const coverage = estimateCoverage(inliers, low, high);
  const samplesUsed = inliers.length;
  const meanWeight =
    inliers.reduce((total, entry) => total + entry.weight, 0) / samplesUsed;
  const confidence = clamp01(
    meanWeight * (1 - Math.exp(-samplesUsed / 12)) * (0.4 + 0.6 * coverage),
  );
  const uncertaintyMeters = Math.max(
    0.05,
    meters * (1 - coverage) * 0.5 + (meters * 0.9) / Math.sqrt(samplesUsed) + 0.02,
  );

  return {
    from: windowed[0].from,
    to: windowed[0].to,
    meters: round(meters, 3),
    uncertaintyMeters: round(uncertaintyMeters, 3),
    biasMs: round(biasMs, 3),
    driftMsPerSecond: round(driftMsPerSecond, 5),
    coverage: round(coverage, 3),
    samplesUsed,
    confidence: round(confidence, 3),
    observedAtHostEpochMs:
      windowed[windowed.length - 1].atHostEpochMs,
  };
}

// Theil–Sen over well-separated observation pairs. The geometric term is
// independent of time, so the median pairwise slope isolates the affine
// drift; restricting to wide time gaps sharpens it (slope noise ∝ 1/Δt).
function estimateDriftMsPerSecond(
  observations: Array<{ tdoaMs: number; atHostEpochMs: number }>,
  maxDriftMsPerSecond: number,
) {
  const first = observations[0].atHostEpochMs;
  const last = observations[observations.length - 1].atHostEpochMs;
  const spanMs = last - first;
  const minSpacingMs = Math.max(MIN_DRIFT_PAIR_SPACING_MS, spanMs * 0.4);
  if (spanMs < 2 * MIN_DRIFT_PAIR_SPACING_MS) {
    return 0;
  }

  const slopes: number[] = [];
  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      const deltaMs =
        observations[j].atHostEpochMs - observations[i].atHostEpochMs;
      if (deltaMs < minSpacingMs) {
        continue;
      }
      slopes.push(
        ((observations[j].tdoaMs - observations[i].tdoaMs) / deltaMs) * 1_000,
      );
    }
  }
  if (slopes.length < 8) {
    return 0;
  }

  slopes.sort((a, b) => a - b);
  const medianSlope = slopes[Math.floor(slopes.length / 2)];

  // Only correct drift that clears its own noise floor: the geometric term
  // is signal here, and subtracting an insignificant slope estimated from it
  // would distort the spread more than real SRO does over short windows.
  const deviations = slopes
    .map((slope) => Math.abs(slope - medianSlope))
    .sort((a, b) => a - b);
  const slopeMad = deviations[Math.floor(deviations.length / 2)];
  const standardError =
    (MAD_TO_SIGMA * slopeMad) / Math.sqrt(observations.length);
  if (Math.abs(medianSlope) < 2 * standardError) {
    return 0;
  }

  return Math.max(
    -maxDriftMsPerSecond,
    Math.min(maxDriftMsPerSecond, medianSlope),
  );
}

// Convergence quality: both extremes should rest on repeated evidence, and
// the span should not still be growing in the most recent quarter of the
// window (a growing span means the talker is still revealing new geometry).
function estimateCoverage(
  inliers: Array<{ value: number; weight: number; atHostEpochMs: number }>,
  low: number,
  high: number,
) {
  const span = Math.max(high - low, 1e-6);
  const edgeBand = span * 0.12;
  let lowSupport = 0;
  let highSupport = 0;
  for (const entry of inliers) {
    if (entry.value - low <= edgeBand) {
      lowSupport += 1;
    }
    if (high - entry.value <= edgeBand) {
      highSupport += 1;
    }
  }
  const supportScore = Math.min(
    1,
    (Math.min(lowSupport, 3) + Math.min(highSupport, 3)) / 6,
  );

  const times = inliers.map((entry) => entry.atHostEpochMs);
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  const cutoff = newest - (newest - oldest) * 0.25;
  const earlier = inliers.filter((entry) => entry.atHostEpochMs <= cutoff);
  let stability = 1;
  if (earlier.length >= 6) {
    const earlierLow = weightedQuantile(earlier, LOW_QUANTILE);
    const earlierHigh = weightedQuantile(earlier, HIGH_QUANTILE);
    if (earlierLow !== null && earlierHigh !== null) {
      stability = clamp01((earlierHigh - earlierLow) / span);
    }
  }

  const density = 1 - Math.exp(-inliers.length / 15);
  return clamp01(supportScore * (0.5 + 0.5 * stability) * density);
}

function weightedQuantile(
  entries: Array<{ value: number; weight: number }>,
  quantile: number,
): number | null {
  if (entries.length === 0) {
    return null;
  }
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((total, entry) => total + entry.weight, 0);
  if (totalWeight <= 0) {
    return null;
  }
  const target = quantile * totalWeight;
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= target) {
      return entry.value;
    }
  }
  return sorted[sorted.length - 1].value;
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
