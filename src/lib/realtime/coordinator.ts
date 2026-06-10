import type { RoomState } from "../session/registry";

export function selectRealtimePeerTargets(
  roomState: RoomState | null,
  deviceId: string,
) {
  if (!roomState?.hostDeviceId || !deviceId) {
    return [];
  }

  if (deviceId === roomState.hostDeviceId) {
    return roomState.devices
      .filter((device) => device.deviceId !== deviceId)
      .sort(compareDevicesByJoin)
      .map((device) => device.deviceId);
  }

  return roomState.devices.some((device) => device.deviceId === deviceId) &&
    roomState.devices.some((device) => device.deviceId === roomState.hostDeviceId)
    ? [roomState.hostDeviceId]
    : [];
}

function compareDevicesByJoin(
  a: RoomState["devices"][number],
  b: RoomState["devices"][number],
) {
  if (a.joinedAt !== b.joinedAt) {
    return a.joinedAt - b.joinedAt;
  }
  return a.deviceId.localeCompare(b.deviceId);
}
