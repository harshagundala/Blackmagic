import {
  estimateConstellation,
  type ConstellationLayout,
  type PairwiseDistance,
} from "./layout";
import type { RoomState, SessionRole } from "@/lib/session/registry";

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
};

export function estimateRoomConstellation(room: RoomState): RoomConstellation {
  const participantIds = room.devices.map((device) => device.deviceId);
  const distances: PairwiseDistance[] = room.ranges.map((range) => ({
    from: range.from,
    to: range.to,
    meters: range.meters,
    weight: range.confidence,
  }));
  const layout = estimateConstellation(participantIds, distances, {
    anchorId: room.hostDeviceId,
    iterations: distances.length > 0 ? 850 : 0,
  });

  return {
    layout,
    devices: room.devices.map((device) => {
      const point = layout.points[device.deviceId] ?? { x: 0, y: 0 };
      const range = strongestRangeForDevice(room, device.deviceId);
      return {
        deviceId: device.deviceId,
        role: device.role,
        x: point.x,
        y: point.y,
        distanceMeters: range?.meters ?? null,
        confidence: range?.confidence ?? layout.quality,
      };
    }),
  };
}

function strongestRangeForDevice(room: RoomState, deviceId: string) {
  return room.ranges
    .filter((range) => range.from === deviceId || range.to === deviceId)
    .sort((a, b) => b.confidence - a.confidence)[0];
}
