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
};

export type RoomConstellation = {
  layout: ConstellationLayout;
  devices: RoomConstellationDevice[];
  audioSources: RoomAudioSourceHint[];
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

export function estimateRoomConstellation(room: RoomState): RoomConstellation {
  const participantIds = room.devices.map((device) => device.deviceId);
  const distances: PairwiseDistance[] = room.ranges.map((range) => ({
    from: range.from,
    to: range.to,
    meters: range.meters,
    weight: rangeLayoutWeight(range),
  }));
  const layout = estimateConstellation(participantIds, distances, {
    anchorId: room.hostDeviceId,
    iterations: distances.length > 0 ? 850 : 0,
  });

  const devices = room.devices.map((device) => {
    const point = layout.points[device.deviceId] ?? { x: 0, y: 0 };
    const range = strongestRangeForDevice(room, device.deviceId);
    return {
      deviceId: device.deviceId,
      role: device.role,
      x: point.x,
      y: point.y,
      distanceMeters: range?.meters ?? null,
      confidence: range ? rangeLayoutWeight(range) : layout.quality,
    };
  });

  return {
    layout,
    devices,
    audioSources: deriveAudioSourceHints(
      room.audioEvents ?? [],
      devices,
      room.updatedAt,
    ),
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

function strongestRangeForDevice(room: RoomState, deviceId: string) {
  return room.ranges
    .filter((range) => range.from === deviceId || range.to === deviceId)
    .sort((a, b) => rangeLayoutWeight(b) - rangeLayoutWeight(a))[0];
}

function deriveAudioSourceHints(
  events: ReconciledAudioEvent[],
  devices: RoomConstellationDevice[],
  roomUpdatedAtMs: number,
): RoomAudioSourceHint[] {
  const byId = new Map(devices.map((device) => [device.deviceId, device]));

  return events
    .map((event) => {
      return (
        fitAudioSourceByTdoa(event, devices, roomUpdatedAtMs) ??
        projectLeaderSideSource(event, byId, devices, roomUpdatedAtMs)
      );
    })
    .filter((source): source is RoomAudioSourceHint => source !== null);
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
        a.detectedAtHostEpochMs - b.detectedAtHostEpochMs ||
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
      observation.detectedAtHostEpochMs - leader.detectedAtHostEpochMs;
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

function round(value: number) {
  return Number(value.toFixed(3));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
