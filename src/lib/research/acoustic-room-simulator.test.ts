import { describe, expect, test } from "vitest";
import { simulateAcousticRoom } from "./acoustic-room-simulator";

describe("acoustic room simulator", () => {
  test("drives registry ranging and layout from physical phone coordinates", () => {
    const result = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab",
      sampleRate: 48_000,
      devices: [
        { deviceId: "host", x: 0, y: 0 },
        { deviceId: "phone-a", x: 2.15, y: 0.35 },
        { deviceId: "phone-b", x: 0.75, y: 2.35 },
      ],
      exchangesPerPair: 3,
      sampleNoiseStdDev: 0.12,
    });

    expect(result.roomState.devices.map((device) => device.deviceId)).toEqual([
      "host",
      "phone-a",
      "phone-b",
    ]);
    expect(result.roomState.ranges).toHaveLength(3);
    expect(result.constellation.layout.stress).toBeLessThan(0.16);
    expect(result.maxRangeErrorMeters).toBeLessThan(0.08);
    expect(result.maxLayoutPairErrorMeters).toBeLessThan(0.22);
  });
});
