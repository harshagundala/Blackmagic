import { describe, expect, test } from "vitest";
import {
  summarizePhysicalRoomValidationTrace,
  type PhysicalRoomValidationSnapshot,
} from "./validation-trace";

describe("validation trace", () => {
  test("summarizes time to a sustained ready room", () => {
    const summary = summarizePhysicalRoomValidationTrace(
      [
        snapshot(1_000, "warming", ["clock_not_ready"], {
          deviceCount: 1,
          localizedDeviceCount: 0,
          rangeCount: 0,
          tdoaSourceCount: 0,
        }),
        snapshot(4_000, "warming", ["no_tdoa_source"], {
          deviceCount: 3,
          localizedDeviceCount: 3,
          rangeCount: 3,
          tdoaSourceCount: 0,
        }),
        snapshot(7_000, "ready", [], {
          deviceCount: 3,
          localizedDeviceCount: 3,
          rangeCount: 3,
          audioTimestampReadyDeviceCount: 3,
          tdoaSourceCount: 1,
          worstAudioTimestampErrorMs: 3.4,
          lowestAudioTimingConfidence: 0.78,
          bestSourceResidualMs: 2.1,
        }),
        snapshot(11_000, "ready", [], {
          deviceCount: 3,
          localizedDeviceCount: 3,
          rangeCount: 3,
          audioTimestampReadyDeviceCount: 3,
          tdoaSourceCount: 1,
          worstAudioTimestampErrorMs: 2.8,
          lowestAudioTimingConfidence: 0.81,
          bestSourceResidualMs: 1.7,
        }),
      ],
      { requiredReadyStreakMs: 3_000 },
    );

    expect(summary.status).toBe("ready");
    expect(summary.sampleCount).toBe(4);
    expect(summary.durationMs).toBe(10_000);
    expect(summary.firstReadyAtMs).toBe(7_000);
    expect(summary.timeToReadyMs).toBe(6_000);
    expect(summary.readyStreakMs).toBe(4_000);
    expect(summary.finalBlockers).toEqual([]);
    expect(summary.observedBlockers).toEqual([
      "clock_not_ready",
      "no_tdoa_source",
    ]);
    expect(summary.peakLocalizedDeviceCount).toBe(3);
    expect(summary.peakAudioTimestampReadyDeviceCount).toBe(3);
    expect(summary.worstAudioTimestampErrorMs).toBe(3.4);
    expect(summary.lowestAudioTimingConfidence).toBe(0.78);
    expect(summary.peakTdoaSourceCount).toBe(1);
    expect(summary.bestSourceResidualMs).toBe(1.7);
  });

  test("keeps final blockers when a trace never becomes ready", () => {
    const summary = summarizePhysicalRoomValidationTrace([
      snapshot(2_000, "warming", ["clock_not_ready"], {
        deviceCount: 2,
        localizedDeviceCount: 0,
        rangeCount: 0,
      }),
      snapshot(5_000, "warming", ["clock_not_ready", "no_tdoa_source"], {
        deviceCount: 3,
        localizedDeviceCount: 2,
        rangeCount: 2,
      }),
    ]);

    expect(summary.status).toBe("warming");
    expect(summary.firstReadyAtMs).toBeNull();
    expect(summary.timeToReadyMs).toBeNull();
    expect(summary.readyStreakMs).toBe(0);
    expect(summary.finalBlockers).toEqual([
      "clock_not_ready",
      "no_tdoa_source",
    ]);
    expect(summary.observedBlockers).toEqual([
      "clock_not_ready",
      "no_tdoa_source",
    ]);
  });
});

function snapshot(
  capturedAtMs: number,
  status: PhysicalRoomValidationSnapshot["validation"]["status"],
  blockers: string[],
  metrics: Partial<
    PhysicalRoomValidationSnapshot["validation"]["metrics"]
  > = {},
): PhysicalRoomValidationSnapshot {
  return {
    capturedAtMs,
    sessionKey: "https://blackmagic.app/lab",
    revision: capturedAtMs,
    validation: {
      status,
      phoneLayout: {
        status,
        blockers,
      },
      audioTimestamps: {
        status,
        blockers,
      },
      spokenSource: {
        status,
        blockers,
      },
      blockers,
      metrics: {
        deviceCount: 0,
        localizedDeviceCount: 0,
        rangeCount: 0,
        layoutStressMeters: 0,
        clockStatus: status === "ready" ? "ready" : "warming",
        worstClockErrorMs: status === "ready" ? 1.1 : null,
        roomClockConfidence: status === "ready" ? 0.9 : 0,
        audioTimestampDeviceCount: 0,
        audioTimestampReadyDeviceCount: 0,
        worstAudioTimestampErrorMs: null,
        lowestAudioTimingConfidence: null,
        tdoaSourceCount: 0,
        bestSourceResidualMs: null,
        bestSourceConfidence: null,
        ...metrics,
      },
    },
  };
}
