import { describe, expect, test } from "vitest";
import { selectRealtimePeerTargets } from "./coordinator";
import type { RoomState } from "../session/registry";

describe("realtime room coordinator", () => {
  test("host opens data channels to every peer in stable join order", () => {
    expect(
      selectRealtimePeerTargets(
        roomState({
          hostDeviceId: "host",
          devices: [
            device("phone-b", "phone", 300),
            device("host", "host", 100),
            device("phone-a", "phone", 200),
          ],
        }),
        "host",
      ),
    ).toEqual(["phone-a", "phone-b"]);
  });

  test("phones only answer the host coordinator", () => {
    expect(
      selectRealtimePeerTargets(
        roomState({
          hostDeviceId: "host",
          devices: [
            device("host", "host", 100),
            device("phone-a", "phone", 200),
            device("phone-b", "phone", 300),
          ],
        }),
        "phone-a",
      ),
    ).toEqual(["host"]);
  });

  test("solo or hostless rooms do not start peer connections", () => {
    expect(
      selectRealtimePeerTargets(
        roomState({
          hostDeviceId: "host",
          devices: [device("host", "host", 100)],
        }),
        "host",
      ),
    ).toEqual([]);
    expect(
      selectRealtimePeerTargets(
        roomState({
          hostDeviceId: "",
          devices: [device("phone-a", "phone", 100)],
        }),
        "phone-a",
      ),
    ).toEqual([]);
  });
});

function roomState({
  hostDeviceId,
  devices,
}: Pick<RoomState, "hostDeviceId" | "devices">): RoomState {
  return {
    sessionKey: "https://blackmagic.app/room",
    hostDeviceId,
    revision: 1,
    changedAt: 1,
    updatedAt: 1,
    devices,
    calibrationTurn: null,
    timeSync: {
      status: "solo",
      synchronizedDeviceIds: [],
      localizationDeviceIds: [],
      roomConfidence: 0,
      medianMaxErrorMs: null,
      worstLocalizationErrorMs: null,
      devices: [],
    },
    ranges: [],
    audioEvents: [],
  };
}

function device(
  deviceId: string,
  role: RoomState["devices"][number]["role"],
  joinedAt: number,
): RoomState["devices"][number] {
  return {
    deviceId,
    role,
    joinedAt,
    lastSeenAt: joinedAt,
    sessionKey: "https://blackmagic.app/room",
  };
}
