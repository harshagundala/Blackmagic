import { describe, expect, test } from "vitest";
import {
  calibrationEventKey,
  hasPulseLead,
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

  test("requires enough host-clock lead before advertising a pulse", () => {
    const pulse = {
      id: "host:1:12000",
      emittedAtHostEpochMs: 12_000,
      durationMs: 48,
      frequencyHz: 17_200,
    };

    expect(hasPulseLead(pulse, 10_400, 1_500)).toBe(true);
    expect(hasPulseLead(pulse, 10_600, 1_500)).toBe(false);
    expect(hasPulseLead(pulse, Number.NaN, 1_500)).toBe(false);
  });
});
