import {
  estimateConstellation,
  type ConstellationLayout,
  type PairwiseDistance,
} from "./layout";
import type { RoomState, SessionRole } from "@/lib/session/registry";
import type { ReconciledAudioEvent } from "@/lib/session/audio-events";
import type { AcousticRange } from "@/lib/session/ranging";

export type RoomConstellationDevice = {
  deviceId: string;
  role: SessionRole;
  x: number;
  y: number;
  distanceMeters: number | null;
  confidence: number;
  localized: boolean;
};

export type RoomConstellation = {
  layout: ConstellationLayout;
  devices: RoomConstellationDevice[];
  audioSources: RoomAudioSourceHint[];
};

export type RoomConstellationOptions = {
  perspectiveDeviceId?: string | null;
  headingDegrees?: number | null;
};

export type RoomAudioSourceHint = {
  eventId: string;
  x: number;
  y: number;
  confidence: number;
  ageMs: number;
  timeSpreadMs: number;
  method: "arrival-leader" | "tdoa-grid";
  residualMs: number | null;
  arrivalLeaderDeviceId: string;
  observedDeviceIds: string[];
};

export function estimateRoomConstellation(
  room: RoomState,
  options: RoomConstellationOptions = {},
): RoomConstellation {
  const participantIds = room.devices.map((device) => device.deviceId);
  const localizationDeviceIds = localizationDeviceIdsFor(room);
  const ranges = room.ranges.filter((range) =>
    isLocalizationReadyRange(range, localizationDeviceIds),
  );
  const distances: PairwiseDistance[] = ranges.map((range) => ({
    from: range.from,
    to: range.to,
    meters: range.meters,
    weight: rangeLayoutWeight(range),
  }));
  const layout = estimateConstellation(participantIds, distances, {
    anchorId: room.hostDeviceId,
    iterations: distances.length > 0 ? 850 : 0,
  });
  const localizedDeviceIds = localizedDevicesFor(ranges);
  const honestLayout = {
    ...layout,
    points: Object.fromEntries(
      participantIds.map((deviceId) => [
        deviceId,
        localizedDeviceIds.has(deviceId)
          ? (layout.points[deviceId] ?? { x: 0, y: 0 })
          : { x: 0, y: 0 },
      ]),
    ),
  };
  const distanceAnchorDeviceId = options.perspectiveDeviceId ?? room.hostDeviceId;

  const devices = room.devices.map((device) => {
    const point = honestLayout.points[device.deviceId] ?? { x: 0, y: 0 };
    const confidenceRange = strongestRangeForDevice(ranges, device.deviceId);
    const distanceRange = directRangeForDevice(
      ranges,
      device.deviceId,
      distanceAnchorDeviceId,
    );
    const localized = localizedDeviceIds.has(device.deviceId);
    return {
      deviceId: device.deviceId,
      role: device.role,
      x: point.x,
      y: point.y,
      distanceMeters: distanceRange?.meters ?? null,
      confidence:
        localized && confidenceRange ? rangeLayoutWeight(confidenceRange) : 0.12,
      localized,
    };
  });

  return applyPerspective(
    {
      layout: honestLayout,
      devices,
      audioSources: deriveAudioSourceHints(
        room.audioEvents ?? [],
        devices,
        room.updatedAt,
        localizationDeviceIds,
      ),
    },
    room,
    options,
  );
}

function localizedDevicesFor(ranges: AcousticRange[]) {
  const ids = new Set<string>();
  for (const range of ranges) {
    ids.add(range.from);
    ids.add(range.to);
  }
  return ids;
}

function applyPerspective(
  constellation: RoomConstellation,
  room: RoomState,
  options: RoomConstellationOptions,
): RoomConstellation {
  const perspectiveDeviceId = options.perspectiveDeviceId;
  if (!perspectiveDeviceId) {
    return constellation;
  }

  const origin = constellation.layout.points[perspectiveDeviceId];
  if (!origin) {
    return constellation;
  }

  const headingDegrees =
    finiteNumber(options.headingDegrees) ??
    finiteNumber(
      room.devices.find((device) => device.deviceId === perspectiveDeviceId)
        ?.headingDegrees,
    ) ??
    0;
  const transformPoint = (point: { x: number; y: number }) =>
    rotatePoint(
      {
        x: point.x - origin.x,
        y: point.y - origin.y,
      },
      headingDegrees,
    );
  const transformedPoints = Object.fromEntries(
    Object.entries(constellation.layout.points).map(([deviceId, point]) => [
      deviceId,
      transformPoint(point),
    ]),
  );

  return {
    layout: {
      ...constellation.layout,
      points: transformedPoints,
    },
    devices: constellation.devices.map((device) => ({
      ...device,
      ...transformPoint(device),
    })),
    audioSources: constellation.audioSources.map((source) => ({
      ...source,
      ...transformPoint(source),
    })),
  };
}

function rotatePoint(point: { x: number; y: number }, headingDegrees: number) {
  const radians = (-headingDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    x: round(point.x * cos - point.y * sin),
    y: round(point.x * sin + point.y * cos),
  };
}

export function rangeLayoutWeight(range: AcousticRange) {
  const sampleScore = Math.min(
    1.25,
    0.7 + Math.log2(range.samplesUsed + 1) * 0.18,
  );
  const uncertaintyScore =
    1 / (1 + Math.max(0, range.distanceUncertaintyMeters) / 0.75);
  return round(
    Math.max(
      0.03,
      Math.min(1, range.confidence * sampleScore * uncertaintyScore),
    ),
  );
}

function localizationDeviceIdsFor(room: RoomState) {
  const ids = room.timeSync?.localizationDeviceIds;
  return Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
}

function isLocalizationReadyRange(
  range: AcousticRange,
  localizationDeviceIds: Set<string> | null,
) {
  if (!localizationDeviceIds) {
    return true;
  }
  return (
    localizationDeviceIds.has(range.from) && localizationDeviceIds.has(range.to)
  );
}

function strongestRangeForDevice(ranges: AcousticRange[], deviceId: string) {
  return ranges
    .filter((range) => range.from === deviceId || range.to === deviceId)
    .sort((a, b) => rangeLayoutWeight(b) - rangeLayoutWeight(a))[0];
}

function directRangeForDevice(
  ranges: AcousticRange[],
  deviceId: string,
  anchorDeviceId: string | null | undefined,
) {
  if (!anchorDeviceId || anchorDeviceId === deviceId) {
    return null;
  }

  return ranges
    .filter(
      (range) =>
        (range.from === anchorDeviceId && range.to === deviceId) ||
        (range.from === deviceId && range.to === anchorDeviceId),
    )
    .sort((a, b) => rangeLayoutWeight(b) - rangeLayoutWeight(a))[0];
}

function deriveAudioSourceHints(
  events: ReconciledAudioEvent[],
  devices: RoomConstellationDevice[],
  roomUpdatedAtMs: number,
  localizationDeviceIds: Set<string> | null,
): RoomAudioSourceHint[] {
  const byId = new Map(devices.map((device) => [device.deviceId, device]));

  return events
    .map((event) => {
      const localizableEvent = audioEventForLocalization(
        event,
        localizationDeviceIds,
      );
      if (!localizableEvent) {
        return null;
      }

      return (
        fitAudioSourceByTdoa(localizableEvent, devices, roomUpdatedAtMs) ??
        projectLeaderSideSource(localizableEvent, byId, devices, roomUpdatedAtMs)
      );
    })
    .filter((source): source is RoomAudioSourceHint => source !== null);
}

function audioEventForLocalization(
  event: ReconciledAudioEvent,
  localizationDeviceIds: Set<string> | null,
): ReconciledAudioEvent | null {
  if (!localizationDeviceIds) {
    return event;
  }

  const observations = event.observations
    .filter((observation) => localizationDeviceIds.has(observation.deviceId))
    .sort(
      (a, b) =>
        observationHostTime(a) - observationHostTime(b) ||
        a.deviceId.localeCompare(b.deviceId),
    );
  if (observations.length < 2) {
    return null;
  }

  const startedAtHostEpochMs = observationHostTime(observations[0]);
  const endedAtHostEpochMs = observationHostTime(observations.at(-1) ?? observations[0]);
  const centerHostEpochMs =
    observations.reduce(
      (sum, observation) => sum + observationHostTime(observation),
      0,
    ) / observations.length;
  const timingConfidence =
    observations.reduce(
      (sum, observation) => sum + observationTimingConfidence(observation),
      0,
    ) / observations.length;
  const keptFraction = observations.length / Math.max(1, event.observations.length);

  return {
    ...event,
    startedAtHostEpochMs,
    endedAtHostEpochMs,
    centerHostEpochMs: round(centerHostEpochMs),
    timeSpreadMs: round(endedAtHostEpochMs - startedAtHostEpochMs),
    arrivalLeaderDeviceId: observations[0].deviceId,
    observedDeviceIds: observations.map((observation) => observation.deviceId),
    observations,
    timestampUncertaintyMs: round(
      Math.max(...observations.map((observation) => observation.clockUncertaintyMs)),
    ),
    timingConfidence: round(timingConfidence),
    confidence: round(event.confidence * keptFraction),
  };
}

export function fitAudioSourceByTdoa(
  event: ReconciledAudioEvent,
  devices: RoomConstellationDevice[],
  roomUpdatedAtMs: number,
): RoomAudioSourceHint | null {
  const byId = new Map(devices.map((device) => [device.deviceId, device]));
  const observations = event.observations
    .map((observation) => ({
      ...observation,
      device: byId.get(observation.deviceId),
    }))
    .filter(
      (observation): observation is typeof observation & {
        device: RoomConstellationDevice;
      } => Boolean(observation.device),
    )
    .sort(
      (a, b) =>
        observationHostTime(a) - observationHostTime(b) ||
        a.deviceId.localeCompare(b.deviceId),
    );

  if (observations.length < 3) {
    return null;
  }

  const leader = observations.find(
    (observation) => observation.deviceId === event.arrivalLeaderDeviceId,
  );
  if (!leader) {
    return null;
  }

  const bounds = expandedBounds(observations.map((observation) => observation.device));
  const coarse = searchTdoaGrid(event, observations, leader, bounds, 0.18);
  const fineBounds = {
    minX: coarse.x - 0.32,
    maxX: coarse.x + 0.32,
    minY: coarse.y - 0.32,
    maxY: coarse.y + 0.32,
  };
  const fit = searchTdoaGrid(event, observations, leader, fineBounds, 0.025);
  const residualScore = 1 / (1 + fit.residualMs / 12);
  const observerScore = Math.min(1, 0.54 + observations.length * 0.16);
  const timingScore = audioEventTimingConfidence(event);
  const motionScore = audioEventMotionStability(event);

  return {
    eventId: event.id,
    x: round(fit.x),
    y: round(fit.y),
    confidence: round(
      Math.max(
        0.05,
        Math.min(
          1,
          event.confidence *
            residualScore *
            observerScore *
            timingScore *
            motionScore,
        ),
      ),
    ),
    ageMs: Math.max(0, round(roomUpdatedAtMs - event.centerHostEpochMs)),
    timeSpreadMs: event.timeSpreadMs,
    method: "tdoa-grid",
    residualMs: round(fit.residualMs),
    arrivalLeaderDeviceId: event.arrivalLeaderDeviceId,
    observedDeviceIds: event.observedDeviceIds,
  };
}

function projectLeaderSideSource(
  event: ReconciledAudioEvent,
  byId: Map<string, RoomConstellationDevice>,
  devices: RoomConstellationDevice[],
  roomUpdatedAtMs: number,
): RoomAudioSourceHint | null {
  const leader = byId.get(event.arrivalLeaderDeviceId);
  if (!leader) {
    return null;
  }

  const laterObservers = event.observedDeviceIds
    .filter((deviceId) => deviceId !== event.arrivalLeaderDeviceId)
    .map((deviceId) => byId.get(deviceId))
    .filter((device): device is RoomConstellationDevice => Boolean(device));
  const referenceDevices =
    laterObservers.length > 0
      ? laterObservers
      : devices.filter((device) => device.deviceId !== leader.deviceId);
  const reference = centroid(referenceDevices);
  const direction = unitVector({
    x: leader.x - reference.x,
    y: leader.y - reference.y,
  });
  const offsetMeters = 0.72;

  return {
    eventId: event.id,
    x: round(leader.x + direction.x * offsetMeters),
    y: round(leader.y + direction.y * offsetMeters),
    confidence: audioSourceConfidence(event),
    ageMs: Math.max(0, round(roomUpdatedAtMs - event.centerHostEpochMs)),
    timeSpreadMs: event.timeSpreadMs,
    method: "arrival-leader",
    residualMs: null,
    arrivalLeaderDeviceId: event.arrivalLeaderDeviceId,
    observedDeviceIds: event.observedDeviceIds,
  };
}

function searchTdoaGrid(
  event: ReconciledAudioEvent,
  observations: Array<
    ReconciledAudioEvent["observations"][number] & {
      device: RoomConstellationDevice;
    }
  >,
  leader: ReconciledAudioEvent["observations"][number] & {
    device: RoomConstellationDevice;
  },
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  stepMeters: number,
) {
  let best = { x: leader.device.x, y: leader.device.y, residualMs: Infinity };
  for (let x = bounds.minX; x <= bounds.maxX; x += stepMeters) {
    for (let y = bounds.minY; y <= bounds.maxY; y += stepMeters) {
      const residualMs = tdoaResidualMs(event, observations, leader, { x, y });
      if (residualMs < best.residualMs) {
        best = { x, y, residualMs };
      }
    }
  }
  return best;
}

function tdoaResidualMs(
  event: ReconciledAudioEvent,
  observations: Array<
    ReconciledAudioEvent["observations"][number] & {
      device: RoomConstellationDevice;
    }
  >,
  leader: ReconciledAudioEvent["observations"][number] & {
    device: RoomConstellationDevice;
  },
  source: { x: number; y: number },
) {
  const speedOfSoundMetersPerSecond = 343;
  let weightedSquares = 0;
  let totalWeight = 0;
  for (const observation of observations) {
    if (observation.deviceId === leader.deviceId) {
      continue;
    }
    const predictedMs =
      ((distance(source, observation.device) - distance(source, leader.device)) /
        speedOfSoundMetersPerSecond) *
      1_000;
    const observedMs =
      observationHostTime(observation) - observationHostTime(leader);
    const uncertaintyMs = Math.max(
      0.5,
      observation.clockUncertaintyMs + leader.clockUncertaintyMs,
    );
    const timingScore =
      observationTimingConfidence(observation) *
      observationTimingConfidence(leader);
    const motionScore =
      observationMotionStability(observation) *
      observationMotionStability(leader);
    const weight =
      (observation.confidence *
        leader.confidence *
        event.confidence *
        timingScore *
        motionScore) /
      (1 + uncertaintyMs / 8);
    weightedSquares += (predictedMs - observedMs) ** 2 * weight;
    totalWeight += weight;
  }
  return totalWeight === 0
    ? Number.POSITIVE_INFINITY
    : Math.sqrt(weightedSquares / totalWeight);
}

function expandedBounds(devices: RoomConstellationDevice[]) {
  const marginMeters = 2.4;
  return {
    minX: Math.min(...devices.map((device) => device.x)) - marginMeters,
    maxX: Math.max(...devices.map((device) => device.x)) + marginMeters,
    minY: Math.min(...devices.map((device) => device.y)) - marginMeters,
    maxY: Math.max(...devices.map((device) => device.y)) + marginMeters,
  };
}

function distance(from: { x: number; y: number }, to: { x: number; y: number }) {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function centroid(devices: RoomConstellationDevice[]) {
  if (devices.length === 0) {
    return { x: 0, y: 0 };
  }

  return {
    x: devices.reduce((total, device) => total + device.x, 0) / devices.length,
    y: devices.reduce((total, device) => total + device.y, 0) / devices.length,
  };
}

function unitVector(vector: { x: number; y: number }) {
  const length = Math.hypot(vector.x, vector.y);
  if (length <= 0.0001) {
    return { x: -1, y: 0 };
  }
  return { x: vector.x / length, y: vector.y / length };
}

function audioSourceConfidence(event: ReconciledAudioEvent) {
  const observerScore = Math.min(1, 0.62 + event.observedDeviceIds.length * 0.14);
  const timingScore = 1 / (1 + Math.max(0, event.timeSpreadMs) / 120);
  return round(
    Math.max(
      0.05,
      Math.min(
        1,
        event.confidence *
          observerScore *
          timingScore *
          (0.7 + audioEventTimingConfidence(event) * 0.3),
      ),
    ),
  );
}

function audioEventTimingConfidence(event: ReconciledAudioEvent) {
  const eventScore =
    typeof event.timingConfidence === "number" &&
    Number.isFinite(event.timingConfidence)
      ? clamp(event.timingConfidence, 0, 1)
      : 1 / (1 + Math.max(0, event.timestampUncertaintyMs ?? 0) / 24);
  const observationScores =
    event.observations.length > 0
      ? event.observations.map(observationTimingConfidence)
      : [eventScore];
  const meanObservationScore =
    observationScores.reduce((total, score) => total + score, 0) /
    observationScores.length;

  return Math.sqrt(Math.max(0.02, eventScore * meanObservationScore));
}

function audioEventMotionStability(event: ReconciledAudioEvent) {
  if (event.observations.length === 0) {
    return 1;
  }

  return (
    event.observations.reduce(
      (total, observation) => total + observationMotionStability(observation),
      0,
    ) / event.observations.length
  );
}

function observationTimingConfidence(
  observation: ReconciledAudioEvent["observations"][number],
) {
  if (
    typeof observation.timingConfidence === "number" &&
    Number.isFinite(observation.timingConfidence)
  ) {
    return clamp(observation.timingConfidence, 0, 1);
  }

  return 1 / (1 + Math.max(0, observation.clockUncertaintyMs) / 24);
}

function observationMotionStability(
  observation: ReconciledAudioEvent["observations"][number],
) {
  if (
    typeof observation.motionStability === "number" &&
    Number.isFinite(observation.motionStability)
  ) {
    return clamp(observation.motionStability, 0, 1);
  }

  return 1;
}

function observationHostTime(
  observation: ReconciledAudioEvent["observations"][number],
) {
  return (
    observation.refinedDetectedAtHostEpochMs ??
    observation.detectedAtHostEpochMs
  );
}

function round(value: number) {
  return Number(value.toFixed(3));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
