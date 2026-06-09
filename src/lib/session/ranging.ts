import type { RoomDevice } from "./registry";

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

type RawAcousticRange = AcousticRange & {
  amplitude: number;
};

export function deriveAcousticRanges(devices: RoomDevice[]): AcousticRange[] {
  const pulses = devices.flatMap((device) =>
    acousticPulseHistory(device).map((pulse) => ({
      device,
      pulse,
    })),
  );

  if (pulses.length === 0) {
    return [];
  }

  const rawRanges: RawAcousticRange[] = [];

  for (const observer of devices) {
    for (const observation of acousticObservationHistory(observer)) {
      const emitter = pulses.find(({ pulse }) => pulse.id === observation.pulseId);
      if (!emitter || emitter.device.deviceId === observer.deviceId) {
        continue;
      }

      const propagationMs =
        observation.detectedAtHostEpochMs -
        emitter.pulse.emittedAtHostEpochMs;
      if (
        propagationMs <= 0 ||
        propagationMs > MAX_SAME_ROOM_PROPAGATION_MS
      ) {
        continue;
      }

      const meters = (propagationMs / 1_000) * SPEED_OF_SOUND_METERS_PER_SECOND;
      const timingUncertaintyMs = Math.max(
        0,
        observation.clockUncertaintyMs ?? 0,
      );
      rawRanges.push({
        from: emitter.device.deviceId,
        to: observer.deviceId,
        pulseId: emitter.pulse.id,
        pulseIds: [emitter.pulse.id],
        samplesUsed: 1,
        meters: round(meters, 2),
        timingUncertaintyMs: round(timingUncertaintyMs, 3),
        distanceUncertaintyMeters: round(
          (timingUncertaintyMs / 1_000) * SPEED_OF_SOUND_METERS_PER_SECOND,
          2,
        ),
        confidence: rangeConfidence(
          observation.confidence,
          observation.amplitude,
          observation.clockUncertaintyMs ?? 0,
        ),
        observedAtHostEpochMs: observation.detectedAtHostEpochMs,
        amplitude: observation.amplitude,
      });
    }
  }

  return aggregateRanges(rawRanges).sort((a, b) =>
    `${a.from}:${a.to}:${a.pulseId}`.localeCompare(
      `${b.from}:${b.to}:${b.pulseId}`,
    ),
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

function aggregateRanges(ranges: RawAcousticRange[]): AcousticRange[] {
  const groups = new Map<string, RawAcousticRange[]>();
  for (const range of ranges) {
    const key = `${range.from}:${range.to}`;
    groups.set(key, [...(groups.get(key) ?? []), range]);
  }

  return [...groups.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.meters - b.meters);
    const median = sorted[Math.floor(sorted.length / 2)];
    const deviations = sorted
      .map((item) => Math.abs(item.meters - median.meters))
      .sort((a, b) => a - b);
    const medianDeviation = deviations[Math.floor(deviations.length / 2)] ?? 0;
    const threshold = Math.max(0.5, medianDeviation * 3);
    const inliers = group.filter(
      (item) =>
        item.confidence >= 0.2 &&
        Math.abs(item.meters - median.meters) <= threshold,
    );
    const kept = inliers.length > 0 ? inliers : group;
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
      from: latest.from,
      to: latest.to,
      pulseId: latest.pulseId,
      pulseIds: kept
        .sort((a, b) => a.observedAtHostEpochMs - b.observedAtHostEpochMs)
        .map((item) => item.pulseId),
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

function uniqueBy<T>(items: T[], keyFor: (item: T) => string) {
  const map = new Map<string, T>();
  for (const item of items) {
    map.delete(keyFor(item));
    map.set(keyFor(item), item);
  }
  return [...map.values()];
}

function rangeConfidence(
  observationConfidence: number,
  amplitude: number,
  clockUncertaintyMs: number,
) {
  const amplitudeScore = Math.min(1, Math.max(0, amplitude) / 0.35);
  const timingScore = 1 / (1 + Math.max(0, clockUncertaintyMs) / 12);
  return round(
    Math.max(
      0,
      Math.min(1, observationConfidence * amplitudeScore * timingScore),
    ),
    3,
  );
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
