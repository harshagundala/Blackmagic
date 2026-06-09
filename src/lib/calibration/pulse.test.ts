import { describe, expect, test } from "vitest";
import {
  createScheduledAcousticPulse,
  createToneObservation,
} from "./pulse";

describe("active acoustic pulse metadata", () => {
  test("schedules a future host-aligned pulse with a stable id", () => {
    expect(
      createScheduledAcousticPulse({
        deviceId: "host-a",
        sequence: 7,
        hostEpochNowMs: 20_000,
        leadMs: 2_200,
      }),
    ).toEqual({
      id: "host-a:7:22200",
      emittedAtHostEpochMs: 22_200,
      durationMs: 48,
      frequencyHz: 18_500,
    });
  });

  test("creates observations only inside the same-room propagation window", () => {
    const pulse = createScheduledAcousticPulse({
      deviceId: "host-a",
      sequence: 1,
      hostEpochNowMs: 20_000,
      leadMs: 0,
    });

    expect(
      createToneObservation({
        pulse,
        detectedAtHostEpochMs: 20_006,
        micLevel: 0.08,
        clockUncertaintyMs: 2,
      }),
    ).toEqual({
      pulseId: "host-a:1:20000",
      detectedAtHostEpochMs: 20_006,
      amplitude: 0.08,
      confidence: 0.6,
      clockUncertaintyMs: 2,
    });
    expect(
      createToneObservation({
        pulse,
        detectedAtHostEpochMs: 20_090,
        micLevel: 0.08,
        clockUncertaintyMs: 2,
      }),
    ).toBeNull();
    expect(
      createToneObservation({
        pulse,
        detectedAtHostEpochMs: 20_006,
        micLevel: 0.004,
        clockUncertaintyMs: 2,
      }),
    ).toBeNull();
  });
});
