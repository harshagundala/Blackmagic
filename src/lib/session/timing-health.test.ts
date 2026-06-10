import { describe, expect, test } from "vitest";
import { deriveRoomTimeSync } from "./timing-health";
import type { RoomDevice } from "./registry";

describe("room time sync health", () => {
  test("data-channel-grade clocks over real Wi-Fi are localization ready", () => {
    // A peer NTP-synced to the host phone over a WebRTC data channel on a
    // shared network: tens of ms round trip, a few ms of jitter. These must
    // pass the gates — reciprocal ranging cancels absolute clock offsets, so
    // localization only needs the clock to aim the chirp search window.
    const host = device("host", {
      clockQuality: 1,
      clockUncertaintyMs: 0.1,
      clockMaxErrorMs: 0.2,
      clockBestRoundTripMs: 0,
      clockJitterMs: 0,
      clockSamplesUsed: 24,
      clockOffsetStabilityMs: 0,
    });
    const peer = device("phone-a", {
      clockQuality: 0.78,
      clockUncertaintyMs: 9,
      clockMaxErrorMs: 22,
      clockBestRoundTripMs: 34,
      clockJitterMs: 4,
      clockSamplesUsed: 9,
      clockOffsetStabilityMs: 4,
    });

    const sync = deriveRoomTimeSync([host, peer]);

    expect(sync.status).toBe("ready");
    expect(sync.localizationDeviceIds).toEqual(["host", "phone-a"]);
    expect(sync.worstLocalizationErrorMs).toBe(22);
  });

  test("an HTTP-to-serverless clock still reads as degraded", () => {
    const sync = deriveRoomTimeSync([
      device("host", {
        clockQuality: 0.2,
        clockUncertaintyMs: 40,
        clockMaxErrorMs: 80,
        clockBestRoundTripMs: 120,
        clockJitterMs: 16,
        clockSamplesUsed: 9,
        clockOffsetStabilityMs: 16,
      }),
      device("phone-a", {
        clockQuality: 0.15,
        clockUncertaintyMs: 50,
        clockMaxErrorMs: 95,
        clockBestRoundTripMs: 140,
        clockJitterMs: 20,
        clockSamplesUsed: 8,
        clockOffsetStabilityMs: 18,
      }),
    ]);

    expect(sync.status).toBe("degraded");
    expect(sync.localizationDeviceIds).toEqual([]);
  });
});

function device(
  deviceId: string,
  clock: Partial<RoomDevice>,
): RoomDevice {
  return {
    deviceId,
    joinedAt: 0,
    lastSeenAt: 0,
    role: deviceId === "host" ? "host" : "phone",
    sessionKey: "test",
    ...clock,
  };
}
