import type { PairwiseDistance } from "@/lib/positioning/layout";
import type { AcousticPulse, RoomDevice } from "@/lib/session/registry";

export type PhonePair = {
  from: string;
  to: string;
};

export type CalibrationSlot = PhonePair & {
  sequence: number;
  startsAtMs: number;
  durationMs: number;
};

export type CalibrationPlanOptions = {
  chirpsPerPair?: number;
  slotDurationMs?: number;
  guardMs?: number;
};

export type CalibrationPlan = {
  pairs: PhonePair[];
  slots: CalibrationSlot[];
  durationMs: number;
};

export type LiveCalibrationTurnOptions = {
  slotDurationMs?: number;
  pulseOffsetMs?: number;
  minLeadMs?: number;
  pulseDurationMs?: number;
};

export type LiveCalibrationTurn = {
  emitterId: string;
  sequence: number;
  slotStartsAtHostEpochMs: number;
  pulseEmittedAtHostEpochMs: number;
  pulseDurationMs: number;
};

export type ObservablePulseOptions = {
  maxFutureMs?: number;
  maxLateMs?: number;
};

export type PairwiseMeasurement = PhonePair & {
  meters: number;
  confidence: number;
};

export function createPairwiseCalibrationPlan(
  participantIds: string[],
  options: CalibrationPlanOptions = {},
): CalibrationPlan {
  const ids = [...new Set(participantIds.filter(Boolean))];
  const chirpsPerPair = options.chirpsPerPair ?? 4;
  const slotDurationMs = options.slotDurationMs ?? 360;
  const guardMs = options.guardMs ?? 120;
  const strideMs = slotDurationMs + guardMs;
  const pairs: PhonePair[] = [];

  for (let fromIndex = 0; fromIndex < ids.length; fromIndex += 1) {
    for (let toIndex = fromIndex + 1; toIndex < ids.length; toIndex += 1) {
      pairs.push({ from: ids[fromIndex], to: ids[toIndex] });
    }
  }

  const slots: CalibrationSlot[] = [];
  for (const pair of pairs) {
    for (let chirp = 0; chirp < chirpsPerPair; chirp += 1) {
      const sequence = slots.length;
      slots.push({
        ...pair,
        sequence,
        startsAtMs: sequence * strideMs,
        durationMs: slotDurationMs,
      });
    }
  }

  return {
    pairs,
    slots,
    durationMs: slots.length * strideMs,
  };
}

export function selectUpcomingCalibrationTurn(
  participantIds: string[],
  hostEpochNowMs: number,
  options: LiveCalibrationTurnOptions = {},
): LiveCalibrationTurn | null {
  // Canonical order, NOT caller order: every device computes this schedule
  // independently from its own polled room state, and the store does not
  // guarantee device ordering (Redis hgetall). Two phones disagreeing on the
  // order map the same slot to different emitters and chirp on top of each
  // other — observed in the field as two overlapping chirp trains ~170 ms
  // apart (the skew being their differing audio output latencies).
  const ids = [...new Set(participantIds.filter(Boolean))].sort();
  if (ids.length < 2 || !Number.isFinite(hostEpochNowMs)) {
    return null;
  }

  const slotDurationMs = options.slotDurationMs ?? 5_000;
  const pulseOffsetMs = options.pulseOffsetMs ?? 3_400;
  const minLeadMs = options.minLeadMs ?? 2_500;
  const pulseDurationMs = options.pulseDurationMs ?? 80;
  if (
    slotDurationMs <= 0 ||
    pulseOffsetMs < 0 ||
    pulseOffsetMs >= slotDurationMs ||
    minLeadMs < 0 ||
    pulseDurationMs <= 0
  ) {
    return null;
  }

  let sequence = Math.max(0, Math.floor(hostEpochNowMs / slotDurationMs));
  let slotStartsAtHostEpochMs = sequence * slotDurationMs;
  let pulseEmittedAtHostEpochMs = slotStartsAtHostEpochMs + pulseOffsetMs;

  while (pulseEmittedAtHostEpochMs - hostEpochNowMs < minLeadMs) {
    sequence += 1;
    slotStartsAtHostEpochMs = sequence * slotDurationMs;
    pulseEmittedAtHostEpochMs = slotStartsAtHostEpochMs + pulseOffsetMs;
  }

  return {
    emitterId: ids[sequence % ids.length],
    sequence,
    slotStartsAtHostEpochMs,
    pulseEmittedAtHostEpochMs,
    pulseDurationMs,
  };
}

export function selectObservablePulse(
  devices: RoomDevice[],
  observerDeviceId: string,
  hostEpochNowMs: number,
  options: ObservablePulseOptions = {},
): AcousticPulse | null {
  if (!Number.isFinite(hostEpochNowMs)) {
    return null;
  }

  const maxFutureMs = options.maxFutureMs ?? 5_500;
  const maxLateMs = options.maxLateMs ?? 180;
  const observedPulseIds = observedPulseIdsFor(devices, observerDeviceId);
  const candidates = devices
    .flatMap(acousticPulseHistory)
    .filter((pulse) => !observedPulseIds.has(pulse.id))
    .filter((pulse) => {
      const deltaMs = pulse.emittedAtHostEpochMs - hostEpochNowMs;
      return deltaMs <= maxFutureMs && deltaMs >= -maxLateMs;
    })
    .sort(
      (a, b) =>
        Math.abs(a.emittedAtHostEpochMs - hostEpochNowMs) -
        Math.abs(b.emittedAtHostEpochMs - hostEpochNowMs),
    );

  return candidates[0] ?? null;
}

export function selectTrackedPulse(
  devices: RoomDevice[],
  observerDeviceId: string,
  hostEpochNowMs: number,
  currentPulse: AcousticPulse | null,
  options: ObservablePulseOptions = {},
): AcousticPulse | null {
  const observablePulse = selectObservablePulse(
    devices,
    observerDeviceId,
    hostEpochNowMs,
    options,
  );
  if (observablePulse) {
    return observablePulse;
  }

  if (
    currentPulse &&
    !observedPulseIdsFor(devices, observerDeviceId).has(currentPulse.id) &&
    isPulseInsideObservableWindow(currentPulse, hostEpochNowMs, options)
  ) {
    return currentPulse;
  }

  return null;
}

function isPulseInsideObservableWindow(
  pulse: AcousticPulse,
  hostEpochNowMs: number,
  options: ObservablePulseOptions,
) {
  if (!Number.isFinite(hostEpochNowMs)) {
    return false;
  }

  const maxFutureMs = options.maxFutureMs ?? 5_500;
  const maxLateMs = options.maxLateMs ?? 180;
  const deltaMs = pulse.emittedAtHostEpochMs - hostEpochNowMs;
  return deltaMs <= maxFutureMs && deltaMs >= -maxLateMs;
}

function observedPulseIdsFor(devices: RoomDevice[], observerDeviceId: string) {
  const observer = devices.find(
    (device) => device.deviceId === observerDeviceId,
  );
  if (!observer) {
    return new Set<string>();
  }

  return new Set(
    [
      ...(observer.acousticObservations ?? []),
      ...(observer.acousticObservation ? [observer.acousticObservation] : []),
    ]
      .filter(hasSampleAnchor)
      .map((observation) => observation.pulseId),
  );
}

function hasSampleAnchor(
  observation: RoomDevice["acousticObservation"],
): observation is NonNullable<RoomDevice["acousticObservation"]> {
  if (!observation) {
    return false;
  }

  return (
    typeof observation.detectedSampleIndex === "number" &&
    Number.isFinite(observation.detectedSampleIndex) &&
    observation.detectedSampleIndex >= 0 &&
    typeof observation.sampleRate === "number" &&
    Number.isFinite(observation.sampleRate) &&
    observation.sampleRate > 0
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

export function summarizePairwiseMeasurements(
  measurements: PairwiseMeasurement[],
): PairwiseDistance[] {
  const groups = new Map<
    string,
    { from: string; to: string; measurements: PairwiseMeasurement[] }
  >();

  for (const measurement of measurements) {
    if (measurement.meters <= 0 || measurement.confidence <= 0) {
      continue;
    }

    const key = [...[measurement.from, measurement.to].sort()].join(":");
    const group = groups.get(key) ?? {
      from: measurement.from,
      to: measurement.to,
      measurements: [],
    };
    group.measurements.push(measurement);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group.measurements].sort(
        (a, b) => a.meters - b.meters,
      );
      const median = sorted[Math.floor(sorted.length / 2)];
      const deviations = sorted
        .map((item) => Math.abs(item.meters - median.meters))
        .sort((a, b) => a - b);
      const medianDeviation =
        deviations[Math.floor(deviations.length / 2)] ?? 0;
      const inliers = group.measurements.filter((item) => {
        const threshold = Math.max(0.35, medianDeviation * 3);
        return (
          item.confidence >= 0.25 &&
          Math.abs(item.meters - median.meters) <= threshold
        );
      });
      const kept = inliers.length > 0 ? inliers : group.measurements;
      const confidenceMean =
        kept.reduce((sum, item) => sum + item.confidence, 0) / kept.length;
      const spread =
        kept.reduce(
          (sum, item) => sum + Math.abs(item.meters - median.meters),
          0,
        ) / kept.length;
      const weight = Math.max(0.05, confidenceMean / (1 + spread * 2));

      return {
        from: group.from,
        to: group.to,
        meters: roundMeters(median.meters),
        weight: roundWeight(weight),
      };
    })
    .sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
}

function roundMeters(value: number) {
  return Number(value.toFixed(2));
}

function roundWeight(value: number) {
  return Number(value.toFixed(3));
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string) {
  const map = new Map<string, T>();
  for (const item of items) {
    map.delete(keyFor(item));
    map.set(keyFor(item), item);
  }
  return [...map.values()];
}
