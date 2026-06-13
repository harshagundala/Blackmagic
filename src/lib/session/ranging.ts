import type { AcousticObservation, AcousticPulse, RoomDevice } from "./registry";

export type AcousticRange = {
  from: string;
  to: string;
  pulseId: string;
  pulseIds: string[];
  samplesUsed: number;
  meters: number;
  timingUncertaintyMs: number;
  distanceUncertaintyMeters: number;
  confidence: number;
  observedAtHostEpochMs: number;
};

export type AcousticRangeOptions = {
  hostEpochNowMs?: number | null;
  maxRangeAgeMs?: number;
};

const SPEED_OF_SOUND_METERS_PER_SECOND = 343;
const DEFAULT_MAX_RANGE_AGE_MS = 18_000;
const MAX_SAME_ROOM_PROPAGATION_MS = 45;
const MAX_RECIPROCAL_TURN_MS = 12_000;
// Motion-adaptive smoothing of the per-pair distance. When the reciprocal
// measurements agree (phones still), a long memory averages out detector
// noise for sub-decimeter precision; when they are changing (phones being
// moved apart), recent measurements must dominate so the map tracks in real
// time instead of crawling up from a window-averaged middle value. The
// half-life is the age at which a measurement's weight halves.
const STABLE_RANGE_HALF_LIFE_MS = 9_000;
const MOVING_RANGE_HALF_LIFE_MS = 1_400;
// Motion is read from how far the measurements spread relative to their own
// per-measurement uncertainty: ~1 means stationary jitter, large means the
// distance is genuinely moving.
const STATIONARY_SPREAD_RATIO = 1.5;
const MOVING_SPREAD_RATIO = 4;

type PulseWithDevice = {
  device: RoomDevice;
  pulse: AcousticPulse;
};

type SampleAnchor = {
  sampleIndex: number;
  sampleRate: number;
  confidence: number;
  amplitude: number;
  hostEpochMs: number;
};

type RawAcousticRange = AcousticRange & {
  amplitude: number;
};

export function deriveAcousticRanges(
  devices: RoomDevice[],
  options: AcousticRangeOptions = {},
): AcousticRange[] {
  const deviceOrder = new Map(
    devices.map((device, index) => [device.deviceId, index]),
  );
  const pulsesByDevice = new Map(
    devices.map((device) => [
      device.deviceId,
      acousticPulseHistory(device)
        .map((pulse) => ({ device, pulse }))
        .sort((a, b) => a.pulse.emittedAtHostEpochMs - b.pulse.emittedAtHostEpochMs),
    ]),
  );
  const observationsByDevice = new Map(
    devices.map((device) => [
      device.deviceId,
      new Map(
        acousticObservationHistory(device).map((observation) => [
          observation.pulseId,
          observation,
        ]),
      ),
    ]),
  );
  const rawRanges: RawAcousticRange[] = [];

  for (let leftIndex = 0; leftIndex < devices.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < devices.length;
      rightIndex += 1
    ) {
      const left = devices[leftIndex];
      const right = devices[rightIndex];
      const leftPulses = pulsesByDevice.get(left.deviceId) ?? [];
      const rightPulses = pulsesByDevice.get(right.deviceId) ?? [];

      for (const [first, second] of reciprocalPulsePairs(
        leftPulses,
        rightPulses,
      )) {
        const range = deriveReciprocalRange(
          first,
          second,
          observationsByDevice,
        );
        if (range) {
          rawRanges.push(range);
        }
      }
    }
  }

  return aggregateRanges(rawRanges, deviceOrder)
    .filter((range) => isFreshRange(range, options))
    .sort((a, b) =>
      `${a.from}:${a.to}:${a.pulseId}`.localeCompare(
        `${b.from}:${b.to}:${b.pulseId}`,
      ),
    );
}

function reciprocalPulsePairs(
  leftPulses: PulseWithDevice[],
  rightPulses: PulseWithDevice[],
) {
  const pairs = new Map<string, [PulseWithDevice, PulseWithDevice]>();
  appendForwardPairs(pairs, leftPulses, rightPulses);
  appendForwardPairs(pairs, rightPulses, leftPulses);
  return [...pairs.values()].sort(
    ([aFirst], [bFirst]) =>
      aFirst.pulse.emittedAtHostEpochMs - bFirst.pulse.emittedAtHostEpochMs,
  );
}

function appendForwardPairs(
  pairs: Map<string, [PulseWithDevice, PulseWithDevice]>,
  firstPulses: PulseWithDevice[],
  secondPulses: PulseWithDevice[],
) {
  for (const first of firstPulses) {
    const second = secondPulses
      .filter((candidate) => {
        const deltaMs =
          candidate.pulse.emittedAtHostEpochMs -
          first.pulse.emittedAtHostEpochMs;
        return deltaMs > 0 && deltaMs <= MAX_RECIPROCAL_TURN_MS;
      })
      .sort(
        (a, b) =>
          a.pulse.emittedAtHostEpochMs - b.pulse.emittedAtHostEpochMs,
      )[0];
    if (!second) {
      continue;
    }

    pairs.set(`${first.pulse.id}->${second.pulse.id}`, [first, second]);
  }
}

function deriveReciprocalRange(
  first: PulseWithDevice,
  second: PulseWithDevice,
  observationsByDevice: Map<string, Map<string, AcousticObservation>>,
): RawAcousticRange | null {
  const firstDeviceObservations =
    observationsByDevice.get(first.device.deviceId) ?? new Map();
  const secondDeviceObservations =
    observationsByDevice.get(second.device.deviceId) ?? new Map();
  const firstSelfAnchor = sampleAnchorFor({
    observation: firstDeviceObservations.get(first.pulse.id),
  });
  const secondHeardByFirstAnchor = sampleAnchorFor({
    observation: firstDeviceObservations.get(second.pulse.id),
  });
  const firstHeardBySecondAnchor = sampleAnchorFor({
    observation: secondDeviceObservations.get(first.pulse.id),
  });
  const secondSelfAnchor = sampleAnchorFor({
    observation: secondDeviceObservations.get(second.pulse.id),
  });

  if (
    !firstSelfAnchor ||
    !secondHeardByFirstAnchor ||
    !firstHeardBySecondAnchor ||
    !secondSelfAnchor
  ) {
    return null;
  }

  const intervalOnFirstMs = sampleIntervalMs(
    firstSelfAnchor,
    secondHeardByFirstAnchor,
  );
  const intervalOnSecondMs = sampleIntervalMs(
    firstHeardBySecondAnchor,
    secondSelfAnchor,
  );
  if (intervalOnFirstMs === null || intervalOnSecondMs === null) {
    return null;
  }

  const propagationMs = (intervalOnFirstMs - intervalOnSecondMs) / 2;
  if (
    propagationMs <= 0 ||
    propagationMs > MAX_SAME_ROOM_PROPAGATION_MS
  ) {
    return null;
  }

  const anchors = [
    firstSelfAnchor,
    secondHeardByFirstAnchor,
    firstHeardBySecondAnchor,
    secondSelfAnchor,
  ];
  const meters = (propagationMs / 1_000) * SPEED_OF_SOUND_METERS_PER_SECOND;
  const timingUncertaintyMs = reciprocalTimingUncertaintyMs(
    anchors,
    Math.max(intervalOnFirstMs, intervalOnSecondMs),
  );

  return {
    from: first.device.deviceId,
    to: second.device.deviceId,
    pulseId: second.pulse.id,
    pulseIds: [first.pulse.id, second.pulse.id],
    samplesUsed: 1,
    meters: round(meters, 2),
    timingUncertaintyMs: round(timingUncertaintyMs, 3),
    distanceUncertaintyMeters: round(
      (timingUncertaintyMs / 1_000) * SPEED_OF_SOUND_METERS_PER_SECOND,
      2,
    ),
    confidence: reciprocalRangeConfidence(anchors, timingUncertaintyMs),
    observedAtHostEpochMs: Math.max(...anchors.map((anchor) => anchor.hostEpochMs)),
    amplitude: average(anchors.map((anchor) => anchor.amplitude)),
  };
}

function sampleAnchorFor({
  observation,
}: {
  observation: AcousticObservation | undefined;
}): SampleAnchor | null {
  if (
    observation &&
    isUsableSampleIndex(observation.detectedSampleIndex) &&
    isUsableSampleRate(observation.sampleRate)
  ) {
    return {
      // Keep the fractional sample index: the detector resolves sub-sample
      // peaks and one sample is already ~7 mm of sound travel at 48 kHz.
      sampleIndex: observation.detectedSampleIndex,
      sampleRate: observation.sampleRate,
      confidence: observation.confidence,
      amplitude: observation.amplitude,
      hostEpochMs: observation.detectedAtHostEpochMs,
    };
  }

  return null;
}

function sampleIntervalMs(start: SampleAnchor, end: SampleAnchor) {
  if (!compatibleSampleRates(start.sampleRate, end.sampleRate)) {
    return null;
  }

  const deltaSamples = end.sampleIndex - start.sampleIndex;
  if (deltaSamples <= 0) {
    return null;
  }

  return (deltaSamples / average([start.sampleRate, end.sampleRate])) * 1_000;
}

function compatibleSampleRates(left: number, right: number) {
  return Math.abs(left - right) / Math.max(left, right) < 0.01;
}

// Relative audio-crystal rate tolerance between two phones (±25 ppm each).
// The ETOA equation measures both intervals on different audio clocks, so
// their rate mismatch over the reciprocal turn is the dominant error term.
const RELATIVE_AUDIO_CLOCK_RATE_TOLERANCE = 5e-5;
// Sub-sample interpolation leaves a residual fraction of one sample period.
const SUBSAMPLE_RESIDUAL_FRACTION = 0.35;
// A weak correlation peak in a reverberant room can sit anywhere inside the
// correlation envelope (~1 / chirp bandwidth, about 0.5 ms for a 2 kHz sweep).
const DETECTION_ENVELOPE_MS = 0.5;

function reciprocalTimingUncertaintyMs(
  anchors: SampleAnchor[],
  turnIntervalMs: number,
) {
  // Host-clock offset uncertainty is deliberately absent: the reciprocal
  // equation only uses same-device sample intervals, so it cancels.
  const quantizationMs =
    Math.max(...anchors.map((anchor) => 1_000 / anchor.sampleRate)) *
    SUBSAMPLE_RESIDUAL_FRACTION;
  const rateDriftMs =
    Math.max(0, turnIntervalMs) * RELATIVE_AUDIO_CLOCK_RATE_TOLERANCE;
  const worstConfidence = Math.min(
    ...anchors.map((anchor) => Math.max(0, Math.min(1, anchor.confidence))),
  );
  const detectionMs = DETECTION_ENVELOPE_MS * (1 - worstConfidence);

  return quantizationMs + rateDriftMs + detectionMs;
}

// No absolute-amplitude term: a room-scale chirp on a phone transducer
// arrives around 1e-3 full-scale, so loudness-anchored scores zero out real
// ranges. The anchors' confidences already encode how unambiguous each
// matched-filter detection was; timing closes the loop.
function reciprocalRangeConfidence(
  anchors: SampleAnchor[],
  timingUncertaintyMs: number,
) {
  const confidenceMean = average(anchors.map((anchor) => anchor.confidence));
  const timingScore = 1 / (1 + Math.max(0, timingUncertaintyMs) / 2);
  return round(Math.max(0, Math.min(1, confidenceMean * timingScore)), 3);
}

function acousticPulseHistory(device: RoomDevice) {
  return uniqueBy(
    [
      ...(device.acousticPulses ?? []),
      ...(device.acousticPulse ? [device.acousticPulse] : []),
    ],
    (pulse) => pulse.id,
  );
}

function acousticObservationHistory(device: RoomDevice) {
  return uniqueBy(
    [
      ...(device.acousticObservations ?? []),
      ...(device.acousticObservation ? [device.acousticObservation] : []),
    ],
    (observation) => observation.pulseId,
  );
}

function aggregateRanges(
  ranges: RawAcousticRange[],
  deviceOrder: Map<string, number>,
): AcousticRange[] {
  const groups = new Map<
    string,
    { from: string; to: string; ranges: RawAcousticRange[] }
  >();
  for (const range of ranges) {
    const pair = canonicalPair(range.from, range.to, deviceOrder);
    const key = `${pair.from}:${pair.to}`;
    const group = groups.get(key) ?? { ...pair, ranges: [] };
    group.ranges.push(range);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap((group) => {
    const byTime = [...group.ranges].sort(
      (a, b) => a.observedAtHostEpochMs - b.observedAtHostEpochMs,
    );
    const kept = rejectTemporalOutliers(byTime);
    if (kept.length === 0) {
      return [];
    }
    const newestEpochMs = kept[kept.length - 1].observedAtHostEpochMs;
    const meanUncertainty = Math.max(
      0.08,
      kept.reduce((sum, item) => sum + item.distanceUncertaintyMeters, 0) /
        kept.length,
    );
    // Spread of the measurements relative to their own uncertainty is the
    // motion signal; it sets how fast the memory forgets (short half-life
    // while moving, long while still).
    const center =
      kept.reduce((sum, item) => sum + item.meters, 0) / kept.length;
    const rmsSpread = Math.sqrt(
      kept.reduce((sum, item) => sum + (item.meters - center) ** 2, 0) /
        kept.length,
    );
    const spreadRatio = rmsSpread / meanUncertainty;
    const motion = clamp01(
      (spreadRatio - STATIONARY_SPREAD_RATIO) /
        (MOVING_SPREAD_RATIO - STATIONARY_SPREAD_RATIO),
    );
    const halfLifeMs =
      STABLE_RANGE_HALF_LIFE_MS +
      motion * (MOVING_RANGE_HALF_LIFE_MS - STABLE_RANGE_HALF_LIFE_MS);

    const weightOf = (item: RawAcousticRange) =>
      Math.max(0.001, item.confidence) *
      2 ** (-(newestEpochMs - item.observedAtHostEpochMs) / halfLifeMs);
    const weightSum = kept.reduce((sum, item) => sum + weightOf(item), 0);
    const weightedMeanMeters =
      kept.reduce((sum, item) => sum + item.meters * weightOf(item), 0) /
      weightSum;

    // A recency-weighted mean still TRAILS a steady drag by a time constant
    // (it is a low-pass filter and a moving distance is a ramp). Estimating
    // the trend's slope and reading it at the newest measurement cancels that
    // lag, so the map tracks the drag in real time. The slope correction is
    // scaled by `motion`, so still phones collapse to the precise weighted
    // mean (no slope jitter) while moving ones get the lag-free estimate.
    const secondsBeforeNewest = (item: RawAcousticRange) =>
      (item.observedAtHostEpochMs - newestEpochMs) / 1_000;
    const meanTime =
      kept.reduce((sum, item) => sum + secondsBeforeNewest(item) * weightOf(item), 0) /
      weightSum;
    let varTime = 0;
    let covTimeMeters = 0;
    for (const item of kept) {
      const w = weightOf(item);
      const dt = secondsBeforeNewest(item) - meanTime;
      varTime += w * dt * dt;
      covTimeMeters += w * dt * (item.meters - weightedMeanMeters);
    }
    const slopeMetersPerSecond = varTime > 1e-6 ? covTimeMeters / varTime : 0;
    // Evaluate the fitted line at the newest measurement (t = 0): the trailing
    // measurements sit at negative time, so this projects the estimate forward
    // to where the trend says the phones are now. Cap the correction to the
    // data's own spread so a noisy slope can never extrapolate wildly.
    const rawCorrection = motion * slopeMetersPerSecond * -meanTime;
    const correction = clampMagnitude(rawCorrection, 1.5 * rmsSpread);
    const meters = Math.max(0, weightedMeanMeters + correction);
    // Uncertainty and confidence are weighted the same way, so a stale
    // pre-move measurement neither inflates the error bar nor drags the
    // estimate once recent measurements disagree with it.
    const timingUncertaintyMs =
      kept.reduce((sum, item) => sum + item.timingUncertaintyMs * weightOf(item), 0) /
      weightSum;
    const weightedSpread =
      kept.reduce(
        (sum, item) => sum + Math.abs(item.meters - meters) * weightOf(item),
        0,
      ) / weightSum;
    const confidenceMean =
      kept.reduce((sum, item) => sum + item.confidence * weightOf(item), 0) /
      weightSum;
    const latest = kept[kept.length - 1];

    return {
      from: group.from,
      to: group.to,
      pulseId: latest.pulseId,
      pulseIds: uniqueBy(
        kept.flatMap((item) => item.pulseIds),
        (pulseId) => pulseId,
      ),
      samplesUsed: kept.length,
      meters: round(meters, 2),
      timingUncertaintyMs: round(timingUncertaintyMs, 3),
      distanceUncertaintyMeters: round(
        (timingUncertaintyMs / 1_000) * SPEED_OF_SOUND_METERS_PER_SECOND,
        2,
      ),
      confidence: round(
        Math.max(0, Math.min(1, confidenceMean / (1 + weightedSpread))),
        3,
      ),
      observedAtHostEpochMs: latest.observedAtHostEpochMs,
    };
  });
}

// Time-aware outlier rejection: a measurement is dropped only when it
// disagrees with its immediate TIME-neighbors (an isolated bad detection),
// not when it disagrees with the window's global median. Rejecting by global
// median treats the new, farther position during a move as an outlier and is
// exactly what made the map crawl behind a drag; a local-median test keeps a
// genuine trend while still discarding lone spikes.
function rejectTemporalOutliers(sortedByTime: RawAcousticRange[]) {
  const candidates = sortedByTime.filter((range) => range.confidence >= 0.2);
  if (candidates.length <= 1) {
    return candidates;
  }
  const tolerance = rangeConsensusTolerance(candidates);
  // Two measurements that disagree beyond tolerance cannot be arbitrated —
  // there is no third opinion to say which is the bad detection — so neither
  // is trusted. (A genuine move is confirmed by a third measurement on the
  // next exchange, at which point the local-median test below keeps it.)
  if (candidates.length === 2) {
    return Math.abs(candidates[0].meters - candidates[1].meters) <= tolerance
      ? candidates
      : [];
  }
  return candidates.filter((item, index) => {
    const low = Math.max(0, index - 1);
    const high = Math.min(candidates.length - 1, index + 1);
    const localMedian = median(
      candidates.slice(low, high + 1).map((range) => range.meters),
    );
    return Math.abs(item.meters - localMedian) <= tolerance;
  });
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function clampMagnitude(value: number, limit: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const bound = Math.max(0, limit);
  return Math.max(-bound, Math.min(bound, value));
}

function rangeConsensusTolerance(ranges: RawAcousticRange[]) {
  const uncertaintyMeters =
    ranges.reduce((sum, range) => sum + range.distanceUncertaintyMeters, 0) /
    ranges.length;
  return Math.max(0.85, uncertaintyMeters * 3);
}

function isFreshRange(range: AcousticRange, options: AcousticRangeOptions) {
  const hostEpochNowMs = options.hostEpochNowMs;
  if (typeof hostEpochNowMs !== "number" || !Number.isFinite(hostEpochNowMs)) {
    return true;
  }

  const maxRangeAgeMs = options.maxRangeAgeMs ?? DEFAULT_MAX_RANGE_AGE_MS;
  if (maxRangeAgeMs <= 0) {
    return false;
  }

  return hostEpochNowMs - range.observedAtHostEpochMs <= maxRangeAgeMs;
}

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle];
  }
  return (values[middle - 1] + values[middle]) / 2;
}

function canonicalPair(
  a: string,
  b: string,
  deviceOrder: Map<string, number>,
) {
  const aOrder = deviceOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
  const bOrder = deviceOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
  if (aOrder < bOrder || (aOrder === bOrder && a.localeCompare(b) <= 0)) {
    return { from: a, to: b };
  }
  return { from: b, to: a };
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string) {
  const map = new Map<string, T>();
  for (const item of items) {
    map.delete(keyFor(item));
    map.set(keyFor(item), item);
  }
  return [...map.values()];
}

function isUsableSampleIndex(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsableSampleRate(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
