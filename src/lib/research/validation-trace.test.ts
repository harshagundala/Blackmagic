import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createPhysicalRoomTrialEvidence,
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

  test("creates a shareable physical-room trial evidence packet", () => {
    const snapshots = [
      snapshot(
        1_000,
        "warming",
        ["insufficient_acoustic_ranges"],
        {
          deviceCount: 2,
          localizedDeviceCount: 0,
          rangeCount: 0,
        },
        [device("host", { role: "host" }), device("phone-a")],
        1_100,
      ),
      snapshot(
        7_000,
        "ready",
        [],
        {
          deviceCount: 3,
          localizedDeviceCount: 3,
          rangeCount: 3,
          audioCaptureReadyDeviceCount: 3,
          audioTimestampReadyDeviceCount: 3,
          tdoaSourceCount: 1,
          worstAudioTimestampErrorMs: 1.1,
          lowestAudioTimingConfidence: 0.94,
          bestSourceResidualMs: 1.7,
        },
        [
          device("host", { role: "host", localized: true }),
          device("phone-a", { localized: true, distanceMeters: 2.18 }),
          device("phone-b", { localized: true, distanceMeters: 2.04 }),
        ],
        7_100,
      ),
      snapshot(
        13_000,
        "ready",
        [],
        {
          deviceCount: 3,
          localizedDeviceCount: 3,
          rangeCount: 3,
          audioCaptureReadyDeviceCount: 3,
          audioTimestampReadyDeviceCount: 3,
          tdoaSourceCount: 1,
          worstAudioTimestampErrorMs: 0.9,
          lowestAudioTimingConfidence: 0.95,
          bestSourceResidualMs: 1.3,
        },
        [
          device("host", { role: "host", localized: true }),
          device("phone-a", { localized: true, distanceMeters: 2.19 }),
          device("phone-b", { localized: true, distanceMeters: 2.02 }),
        ],
        13_100,
      ),
    ];

    const evidence = createPhysicalRoomTrialEvidence({
      baseUrl: "https://blackmagic-rouge.vercel.app",
      generatedAtMs: 14_000,
      requiredReadyStreakMs: 5_000,
      sessionUrl: "https://blackmagic-rouge.vercel.app/lab",
      snapshots,
    });

    expect(evidence).toEqual(
      expect.objectContaining({
        protocolVersion: 1,
        baseUrl: "https://blackmagic-rouge.vercel.app",
        generatedAtMs: 14_000,
        requiredReadyStreakMs: 5_000,
        sessionUrl: "https://blackmagic-rouge.vercel.app/lab",
        sessionKey: "https://blackmagic.app/lab",
        passed: true,
        sampleWindow: {
          firstCapturedAtMs: 1_000,
          lastCapturedAtMs: 13_000,
          durationMs: 12_000,
          sampleCount: 3,
        },
        finalSnapshot: expect.objectContaining({
          capturedAtMs: 13_000,
          revision: 13_000,
          updatedAtMs: 13_100,
          status: "ready",
          blockers: [],
        }),
      }),
    );
    expect(evidence.gates).toEqual([
      expect.objectContaining({
        id: "sustained_ready",
        passed: true,
        observed: 6_000,
        required: 5_000,
      }),
      expect.objectContaining({
        id: "minimum_devices",
        passed: true,
        observed: 3,
        required: 3,
      }),
      expect.objectContaining({
        id: "localized_devices",
        passed: true,
        observed: 3,
        required: 3,
      }),
      expect.objectContaining({
        id: "acoustic_ranges",
        passed: true,
        observed: 3,
        required: 3,
      }),
      expect.objectContaining({
        id: "audio_capture",
        passed: true,
        observed: 3,
        required: 3,
      }),
      expect.objectContaining({
        id: "audio_timestamps",
        passed: true,
        observed: 3,
        required: 3,
      }),
      expect.objectContaining({
        id: "tdoa_source",
        passed: true,
        observed: 1,
        required: 1,
      }),
    ]);
    expect(evidence.summary.devices).toHaveLength(3);
  });

  test("adds prioritized next actions when trial evidence fails", () => {
    const evidence = createPhysicalRoomTrialEvidence({
      baseUrl: "https://blackmagic-rouge.vercel.app",
      generatedAtMs: 8_000,
      requiredReadyStreakMs: 5_000,
      sessionUrl: "https://blackmagic-rouge.vercel.app/lab",
      snapshots: [
        snapshot(
          1_000,
          "warming",
          [
            "insufficient_devices",
            "insufficient_acoustic_ranges",
            "insufficient_audio_capture",
            "insufficient_audio_timestamps",
            "no_tdoa_source",
          ],
          {
            deviceCount: 2,
            localizedDeviceCount: 1,
            rangeCount: 0,
            audioCaptureReadyDeviceCount: 1,
            audioTimestampReadyDeviceCount: 1,
            tdoaSourceCount: 0,
          },
          [
            device("host", { role: "host", localized: true }),
            device("phone-a", {
              audioCaptureReady: false,
              audioTimestampReady: false,
              blockers: ["audio_capture_missing", "audio_timestamp_missing"],
            }),
          ],
        ),
      ],
    });

    expect(evidence.passed).toBe(false);
    expect(evidence.failedGateIds).toEqual([
      "sustained_ready",
      "minimum_devices",
      "localized_devices",
      "acoustic_ranges",
      "audio_capture",
      "audio_timestamps",
      "tdoa_source",
    ]);
    expect(evidence.nextActions).toEqual([
      expect.objectContaining({
        id: "connect_more_phones",
        gates: ["minimum_devices"],
        deviceIds: [],
      }),
      expect.objectContaining({
        id: "enable_microphone_capture",
        gates: ["audio_capture"],
        deviceIds: ["phone-a"],
      }),
      expect.objectContaining({
        id: "stabilize_audio_timestamps",
        gates: ["audio_timestamps"],
        deviceIds: ["phone-a"],
      }),
      expect.objectContaining({
        id: "complete_acoustic_calibration",
        gates: ["localized_devices", "acoustic_ranges"],
      }),
      expect.objectContaining({
        id: "capture_spoken_source",
        gates: ["tdoa_source"],
      }),
      expect.objectContaining({
        id: "hold_ready_state",
        gates: ["sustained_ready"],
      }),
    ]);
  });

  test("writes an evidence packet from an existing NDJSON trace", () => {
    const directory = mkdtempSync(join(tmpdir(), "blackmagic-trace-"));
    const tracePath = join(directory, "trace.ndjson");
    const evidencePath = join(directory, "evidence.json");
    const snapshots = [
      snapshot(
        1_000,
        "ready",
        [],
        {
          deviceCount: 3,
          localizedDeviceCount: 3,
          rangeCount: 3,
          audioCaptureReadyDeviceCount: 3,
          audioTimestampReadyDeviceCount: 3,
          tdoaSourceCount: 1,
        },
        [
          device("host", { role: "host", localized: true }),
          device("phone-a", { localized: true, distanceMeters: 2.18 }),
          device("phone-b", { localized: true, distanceMeters: 2.04 }),
        ],
      ),
      snapshot(
        7_000,
        "ready",
        [],
        {
          deviceCount: 3,
          localizedDeviceCount: 3,
          rangeCount: 3,
          audioCaptureReadyDeviceCount: 3,
          audioTimestampReadyDeviceCount: 3,
          tdoaSourceCount: 1,
        },
        [
          device("host", { role: "host", localized: true }),
          device("phone-a", { localized: true, distanceMeters: 2.19 }),
          device("phone-b", { localized: true, distanceMeters: 2.02 }),
        ],
      ),
    ];

    writeFileSync(
      tracePath,
      snapshots.map((item) => JSON.stringify(item)).join("\n") + "\n",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/blackmagic-validation-trace.mjs",
          "https://blackmagic-rouge.vercel.app/lab",
          "--from",
          tracePath,
          "--evidence-out",
          evidencePath,
          "--ready-streak-ms",
          "5000",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        passed: boolean;
        gates: Array<{ id: string; passed: boolean }>;
        summary: { devices: Array<{ deviceId: string }> };
      };

      expect(evidence.passed).toBe(true);
      expect(evidence.gates.every((gate) => gate.passed)).toBe(true);
      expect(evidence.summary.devices.map((item) => item.deviceId)).toEqual([
        "host",
        "phone-a",
        "phone-b",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("writes next actions for a failed existing NDJSON trace", () => {
    const directory = mkdtempSync(join(tmpdir(), "blackmagic-trace-failed-"));
    const tracePath = join(directory, "trace.ndjson");
    const evidencePath = join(directory, "evidence.json");
    const snapshots = [
      snapshot(
        1_000,
        "warming",
        ["insufficient_devices", "insufficient_acoustic_ranges"],
        {
          deviceCount: 1,
          localizedDeviceCount: 0,
          rangeCount: 0,
        },
        [device("host", { role: "host" })],
      ),
    ];

    writeFileSync(
      tracePath,
      snapshots.map((item) => JSON.stringify(item)).join("\n") + "\n",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/blackmagic-validation-trace.mjs",
          "https://blackmagic-rouge.vercel.app/lab",
          "--from",
          tracePath,
          "--evidence-out",
          evidencePath,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(2);
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        failedGateIds: string[];
        nextActions: Array<{ id: string }>;
      };

      expect(evidence.failedGateIds).toContain("minimum_devices");
      expect(evidence.nextActions.map((action) => action.id)).toContain(
        "connect_more_phones",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
  updatedAt = capturedAtMs,
): PhysicalRoomValidationSnapshot {
  return {
    capturedAtMs,
    sessionKey: "https://blackmagic.app/lab",
    revision: capturedAtMs,
    updatedAt,
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
