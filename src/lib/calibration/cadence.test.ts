import { describe, expect, test } from "vitest";
import {
  calibrationEventKey,
  shouldFlushCalibrationEvent,
} from "./cadence";

describe("calibration realtime cadence", () => {
  test("keys pulse and observation events separately", () => {
    expect(calibrationEventKey("pulse", "host:1")).toBe("pulse:host:1");
    expect(calibrationEventKey("observation", "host:1")).toBe(
      "observation:host:1",
    );
  });

  test("flushes new calibration events and suppresses duplicate immediate sends", () => {
    expect(shouldFlushCalibrationEvent("", "pulse:host:1")).toBe(true);
    expect(shouldFlushCalibrationEvent("pulse:host:1", "pulse:host:1")).toBe(
      false,
    );
    expect(
      shouldFlushCalibrationEvent("pulse:host:1", "observation:host:1"),
    ).toBe(true);
  });
});
