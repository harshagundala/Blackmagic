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
          unverifiedCaptureDeviceCount: 1,
          tdoaSourceCount: 0,
        }),
        snapshot(7_000, "ready", [], {
          deviceCount: 3,
          localizedDeviceCount: 3,
          rangeCount: 3,
          audioCaptureReadyDeviceCount: 3,
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
          audioCaptureReadyDeviceCount: 3,
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
    expect(summary.peakAudioCaptureReadyDeviceCount).toBe(3);
    expect(summary.peakUnverifiedCaptureDeviceCount).toBe(1);
    expect(summary.peakFilteredCaptureDeviceCount).toBe(0);
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

  test("summarizes per-device blockers across the trace", () => {
    const summary = summarizePhysicalRoomValidationTrace([
      snapshot(
        1_000,
        "warming",
        ["insufficient_audio_capture"],
        {
          deviceCount: 2,
          audioCaptureReadyDeviceCount: 1,
        },
        [
          device("host", {
            role: "host",
            blockers: [],
          }),
          device("phone-a", {
            captureStatus: "missing",
            audioCaptureReady: false,
            audioTimestampPresent: false,
            audioTimestampReady: false,
            audioTimestampErrorMs: null,
            audioTimingConfidence: null,
            blockers: ["audio_capture_missing", "audio_timestamp_missing"],
          }),
        ],
      ),
      snapshot(
        4_000,
        "degraded",
        ["audio_timestamp_error_high"],
        {
          deviceCount: 3,
          audioCaptureReadyDeviceCount: 2,
          worstAudioTimestampErrorMs: 42,
          lowestAudioTimingConfidence: 0.12,
        },
        [
          device("host", {
            role: "host",
            blockers: [],
          }),
          device("phone-a", {
            audioTimestampReady: false,
            audioTimestampErrorMs: 42,
            audioTimingConfidence: 0.12,
            motionStability: 0.62,
            blockers: [
              "audio_timestamp_error_high",
              "audio_timestamp_confidence_low",
            ],
          }),
          device("phone-b", {
            blockers: ["not_localized"],
          }),
        ],
      ),
      snapshot(
        7_000,
        "warming",
        ["no_tdoa_source"],
        {
          deviceCount: 3,
          audioCaptureReadyDeviceCount: 3,
          audioTimestampReadyDeviceCount: 3,
        },
        [
          device("host", {
            role: "host",
            localized: true,
            blockers: [],
          }),
          device("phone-a", {
            localized: true,
            distanceMeters: 2.18,
            blockers: [],
          }),
          device("phone-b", {
            blockers: ["not_localized"],
          }),
        ],
      ),
    ]);

    expect(summary.devices).toEqual([
      expect.objectContaining({
        deviceId: "host",
        role: "host",
        sampleCount: 3,
        firstSeenAtMs: 1_000,
        lastSeenAtMs: 7_000,
        finalBlockers: [],
        observedBlockers: [],
        finalLocalized: true,
        finalCaptureStatus: "verified",
      }),
      expect.objectContaining({
        deviceId: "phone-a",
        role: "phone",
        sampleCount: 3,
        firstSeenAtMs: 1_000,
        lastSeenAtMs: 7_000,
        finalBlockers: [],
        observedBlockers: [
          "audio_capture_missing",
          "audio_timestamp_missing",
          "audio_timestamp_error_high",
          "audio_timestamp_confidence_low",
        ],
        finalLocalized: true,
        finalDistanceMeters: 2.18,
        finalCaptureStatus: "verified",
        finalAudioCaptureReady: true,
        finalAudioTimestampReady: true,
        worstAudioTimestampErrorMs: 42,
        lowestAudioTimingConfidence: 0.12,
        lowestMotionStability: 0.62,
      }),
      expect.objectContaining({
        deviceId: "phone-b",
        role: "phone",
        sampleCount: 2,
        firstSeenAtMs: 4_000,
        lastSeenAtMs: 7_000,
        finalBlockers: ["not_localized"],
        observedBlockers: ["not_localized"],
      }),
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
  devices: PhysicalRoomValidationSnapshot["validation"]["devices"] = [],
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
      audioCapture: {
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
      devices,
      metrics: {
        deviceCount: 0,
        localizedDeviceCount: 0,
        rangeCount: 0,
        layoutStressMeters: 0,
        clockStatus: status === "ready" ? "ready" : "warming",
        worstClockErrorMs: status === "ready" ? 1.1 : null,
        roomClockConfidence: status === "ready" ? 0.9 : 0,
        audioCaptureReadyDeviceCount: 0,
        rawCaptureVerifiedDeviceCount: 0,
        unverifiedCaptureDeviceCount: 0,
        runningAudioContextDeviceCount: 0,
        filteredCaptureDeviceCount: 0,
        suspendedAudioContextDeviceCount: 0,
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

function device(
  deviceId: string,
  overrides: Partial<
    PhysicalRoomValidationSnapshot["validation"]["devices"][number]
  > = {},
): PhysicalRoomValidationSnapshot["validation"]["devices"][number] {
  return {
    deviceId,
    role: "phone",
    mic: "active",
    localized: false,
    distanceMeters: null,
    layoutConfidence: 0.12,
    captureStatus: "verified",
    audioCaptureReady: true,
    audioContextState: "running",
    sampleRate: 48_000,
    audioTimestampPresent: true,
    audioTimestampReady: true,
    audioTimestampErrorMs: 0.7,
    audioTimingConfidence: 0.96,
    clockMaxErrorMs: 0.7,
    clockQuality: 0.98,
    motionStability: 0.94,
    blockers: [],
    ...overrides,
  };
}
