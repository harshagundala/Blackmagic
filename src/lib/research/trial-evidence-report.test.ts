import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { PhysicalRoomTrialEvidence } from "./validation-trace";
import { formatPhysicalRoomTrialEvidenceReport } from "./trial-evidence-report";

describe("trial evidence report", () => {
  test("formats failed evidence with gates, next actions, and device diagnostics", () => {
    const report = formatPhysicalRoomTrialEvidenceReport(failedEvidence());

    expect(report).toContain("BLACKMAGIC FIELD TRIAL: FAIL");
    expect(report).toContain(
      "Session: https://blackmagic-rouge.vercel.app/lab",
    );
    expect(report).toContain(
      "Failed gates: sustained_ready, minimum_devices, audio_capture",
    );
    expect(report).toContain(
      "minimum_devices  FAIL  observed 2 / required 3",
    );
    expect(report).toContain(
      "1. Connect at least three phones to this session URL.",
    );
    expect(report).toContain("Devices: phone-a");
    expect(report).toContain(
      "phone-a  role=phone  localized=no  capture=missing  timestamp=no",
    );
    expect(report).toContain("blockers=audio_capture_missing");
  });

  test("formats passing evidence as a compact pass report", () => {
    const report = formatPhysicalRoomTrialEvidenceReport(passingEvidence());

    expect(report).toContain("BLACKMAGIC FIELD TRIAL: PASS");
    expect(report).toContain("Failed gates: none");
    expect(report).toContain("Next actions: none");
  });

  test("CLI exits nonzero for failed evidence and prints the report", () => {
    const directory = mkdtempSync(join(tmpdir(), "blackmagic-report-"));
    const evidencePath = join(directory, "trial-evidence.json");
    writeFileSync(evidencePath, `${JSON.stringify(failedEvidence())}\n`);

    try {
      const result = spawnSync(
        "npm",
        ["--silent", "run", "trial:report", "--", evidencePath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("BLACKMAGIC FIELD TRIAL: FAIL");
      expect(result.stdout).toContain("Connect at least three phones");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function failedEvidence(): PhysicalRoomTrialEvidence {
  return {
    protocolVersion: 1,
    generatedAtMs: 180_000,
    baseUrl: "https://blackmagic-rouge.vercel.app",
    sessionUrl: "https://blackmagic-rouge.vercel.app/lab",
    sessionKey: "https://blackmagic-rouge.vercel.app/lab",
    requiredReadyStreakMs: 5_000,
    passed: false,
    sampleWindow: {
      firstCapturedAtMs: 120_000,
      lastCapturedAtMs: 180_000,
      durationMs: 60_000,
      sampleCount: 40,
    },
    gates: [
      {
        id: "sustained_ready",
        passed: false,
        observed: 0,
        required: 5_000,
      },
      {
        id: "minimum_devices",
        passed: false,
        observed: 2,
        required: 3,
      },
      {
        id: "audio_capture",
        passed: false,
        observed: 1,
        required: 3,
      },
    ],
    failedGateIds: ["sustained_ready", "minimum_devices", "audio_capture"],
    nextActions: [
      {
        id: "connect_more_phones",
        priority: 10,
        title: "Connect at least three phones to this session URL.",
        detail: "Only 2 phone(s) appeared in the trace.",
        gates: ["minimum_devices"],
        blockers: ["insufficient_devices"],
        deviceIds: [],
      },
      {
        id: "enable_microphone_capture",
        priority: 20,
        title: "Get every phone to verified raw microphone capture.",
        detail: "Tap the page on each phone and allow microphone access.",
        gates: ["audio_capture"],
        blockers: ["audio_capture_missing"],
        deviceIds: ["phone-a"],
      },
    ],
    summary: {
      status: "warming",
      sampleCount: 40,
      durationMs: 60_000,
      firstReadyAtMs: null,
      timeToReadyMs: null,
      readyStreakMs: 0,
      finalBlockers: ["insufficient_devices", "insufficient_audio_capture"],
      observedBlockers: ["insufficient_devices", "audio_capture_missing"],
      peakDeviceCount: 2,
      peakLocalizedDeviceCount: 1,
      peakRangeCount: 0,
      peakAudioCaptureReadyDeviceCount: 1,
      peakUnverifiedCaptureDeviceCount: 0,
      peakFilteredCaptureDeviceCount: 0,
      peakAudioTimestampReadyDeviceCount: 1,
      worstAudioTimestampErrorMs: null,
      lowestAudioTimingConfidence: null,
      peakTdoaSourceCount: 0,
      bestSourceResidualMs: null,
      devices: [
        {
          deviceId: "phone-a",
          role: "phone",
          sampleCount: 40,
          firstSeenAtMs: 120_000,
          lastSeenAtMs: 180_000,
          finalBlockers: ["audio_capture_missing"],
          observedBlockers: ["audio_capture_missing"],
          finalLocalized: false,
          finalDistanceMeters: null,
          finalCaptureStatus: "missing",
          finalAudioCaptureReady: false,
          finalAudioTimestampReady: false,
          worstAudioTimestampErrorMs: null,
          lowestAudioTimingConfidence: null,
          lowestMotionStability: 0.9,
        },
      ],
    },
    finalSnapshot: {
      capturedAtMs: 180_000,
      revision: 42,
      updatedAtMs: 180_000,
      status: "warming",
      blockers: ["insufficient_devices", "insufficient_audio_capture"],
      metrics: null,
      devices: [],
    },
  };
}

function passingEvidence(): PhysicalRoomTrialEvidence {
  return {
    ...failedEvidence(),
    passed: true,
    failedGateIds: [],
    nextActions: [],
    gates: failedEvidence().gates.map((gate) => ({
      ...gate,
      passed: true,
      observed: gate.required,
    })),
    summary: {
      ...failedEvidence().summary,
      status: "ready",
      readyStreakMs: 5_000,
      finalBlockers: [],
    },
    finalSnapshot: {
      ...failedEvidence().finalSnapshot,
      status: "ready",
      blockers: [],
    },
  };
}
