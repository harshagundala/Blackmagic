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

const SPEED_OF_SOUND_METERS_PER_SECOND = 343;
const MAX_SAME_ROOM_PROPAGATION_MS = 45;
const MAX_RECIPROCAL_TURN_MS = 12_000;

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
  source: "observation" | "scheduled-pulse";
};

type RawAcousticRange = AcousticRange & {
  amplitude: number;
};

export function deriveAcousticRanges(devices: RoomDevice[]): AcousticRange[] {
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

  return aggregateRanges(rawRanges, deviceOrder).sort((a, b) =>
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
    pulse: first.pulse,
    observation: firstDeviceObservations.get(first.pulse.id),
    allowScheduledPulseAnchor: true,
  });
  const secondHeardByFirstAnchor = sampleAnchorFor({
    pulse: second.pulse,
    observation: firstDeviceObservations.get(second.pulse.id),
    allowScheduledPulseAnchor: false,
  });
  const firstHeardBySecondAnchor = sampleAnchorFor({
    pulse: first.pulse,
    observation: secondDeviceObservations.get(first.pulse.id),
    allowScheduledPulseAnchor: false,
  });
  const secondSelfAnchor = sampleAnchorFor({
    pulse: second.pulse,
    observation: secondDeviceObservations.get(second.pulse.id),
    allowScheduledPulseAnchor: true,
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
  const timingUncertaintyMs = reciprocalTimingUncertaintyMs(anchors);

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
    confidence: reciprocalRangeConfidence(anchors),
    observedAtHostEpochMs: Math.max(...anchors.map((anchor) => anchor.hostEpochMs)),
    amplitude: average(anchors.map((anchor) => anchor.amplitude)),
  };
}

function sampleAnchorFor({
  pulse,
  observation,
  allowScheduledPulseAnchor,
}: {
  pulse: AcousticPulse;
  observation: AcousticObservation | undefined;
  allowScheduledPulseAnchor: boolean;
}): SampleAnchor | null {
  if (
    observation &&
    isUsableSampleIndex(observation.detectedSampleIndex) &&
    isUsableSampleRate(observation.sampleRate)
  ) {
    return {
      sampleIndex: Math.round(observation.detectedSampleIndex),
      sampleRate: observation.sampleRate,
      confidence: observation.confidence,
      amplitude: observation.amplitude,
      hostEpochMs: observation.detectedAtHostEpochMs,
      source: "observation",
    };
  }

  if (
    allowScheduledPulseAnchor &&
    isUsableSampleIndex(pulse.emittedSampleIndex) &&
    isUsableSampleRate(pulse.sampleRate)
  ) {
    return {
      sampleIndex: Math.round(pulse.emittedSampleIndex),
      sampleRate: pulse.sampleRate,
      confidence: 0.52,
      amplitude: 0.18,
      hostEpochMs: pulse.emittedAtHostEpochMs,
      source: "scheduled-pulse",
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

function reciprocalTimingUncertaintyMs(anchors: SampleAnchor[]) {
  const sampleQuantizationMs = Math.max(
    ...anchors.map((anchor) => 1_000 / anchor.sampleRate),
  );
  const scheduledAnchorPenaltyMs =
    anchors.filter((anchor) => anchor.source === "scheduled-pulse").length * 2;
  return sampleQuantizationMs + scheduledAnchorPenaltyMs;
}

function reciprocalRangeConfidence(anchors: SampleAnchor[]) {
  const confidenceMean = average(anchors.map((anchor) => anchor.confidence));
  const amplitudeScore = Math.min(
    1,
    Math.max(0, average(anchors.map((anchor) => anchor.amplitude))) / 0.28,
  );
  const scheduledPenalty = anchors.reduce(
    (score, anchor) => score * (anchor.source === "scheduled-pulse" ? 0.72 : 1),
    1,
  );

  return round(
    Math.max(0, Math.min(1, confidenceMean * amplitudeScore * scheduledPenalty)),
    3,
  );
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

  return [...groups.values()].map((group) => {
    const sorted = [...group.ranges].sort((a, b) => a.meters - b.meters);
    const median = sorted[Math.floor(sorted.length / 2)];
    const deviations = sorted
      .map((item) => Math.abs(item.meters - median.meters))
      .sort((a, b) => a - b);
    const medianDeviation = deviations[Math.floor(deviations.length / 2)] ?? 0;
    const threshold = Math.max(0.5, medianDeviation * 3);
    const inliers = group.ranges.filter(
      (item) =>
        item.confidence >= 0.2 &&
        Math.abs(item.meters - median.meters) <= threshold,
    );
    const kept = inliers.length > 0 ? inliers : group.ranges;
    const weightSum = kept.reduce(
      (sum, item) => sum + Math.max(0.001, item.confidence),
      0,
    );
    const meters =
      kept.reduce(
        (sum, item) => sum + item.meters * Math.max(0.001, item.confidence),
        0,
      ) / weightSum;
    const timingUncertaintyMs =
      kept.reduce((sum, item) => sum + item.timingUncertaintyMs, 0) /
      kept.length;
    const spread =
      kept.reduce((sum, item) => sum + Math.abs(item.meters - meters), 0) /
      kept.length;
    const confidenceMean =
      kept.reduce((sum, item) => sum + item.confidence, 0) / kept.length;
    const latest = [...kept].sort(
      (a, b) => b.observedAtHostEpochMs - a.observedAtHostEpochMs,
    )[0];

    return {
      from: group.from,
      to: group.to,
      pulseId: latest.pulseId,
      pulseIds: uniqueBy(
        kept
          .sort((a, b) => a.observedAtHostEpochMs - b.observedAtHostEpochMs)
          .flatMap((item) => item.pulseIds),
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
        Math.max(0, Math.min(1, confidenceMean / (1 + spread))),
        3,
      ),
      observedAtHostEpochMs: latest.observedAtHostEpochMs,
    };
  });
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
