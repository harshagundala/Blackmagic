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
        arrivalLeaderDeviceId: event.arrivalLeaderDeviceId,
        observedDeviceIds: event.observedDeviceIds,
      };
    })
    .filter((source): source is RoomAudioSourceHint => source !== null);
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
  return round(Math.max(0.05, Math.min(1, event.confidence * observerScore * timingScore)));
}

function round(value: number) {
  return Number(value.toFixed(3));
}
