import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSimulatedPhysicalRoomTrialEvidence } from "./simulated-trial-evidence";

describe("simulated trial evidence", () => {
  test("creates a passing physical-room evidence packet from the acoustic simulator", () => {
    const result = createSimulatedPhysicalRoomTrialEvidence({
      baseUrl: "https://blackmagic-rouge.vercel.app",
      generatedAtMs: 180_000,
      requiredReadyStreakMs: 5_000,
      roomUrl: "https://blackmagic-rouge.vercel.app/simulated-trial",
    });

    expect(result.evidence.passed).toBe(true);
    expect(result.evidence.summary.status).toBe("ready");
    expect(result.evidence.sampleWindow.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(result.evidence.gates.every((gate) => gate.passed)).toBe(true);
    expect(result.evidence.gates.map((gate) => gate.id)).toEqual([
      "sustained_ready",
      "minimum_devices",
      "localized_devices",
      "acoustic_ranges",
      "audio_capture",
      "audio_timestamps",
      "tdoa_source",
    ]);
    expect(result.evidence.finalSnapshot.metrics).toEqual(
      expect.objectContaining({
        deviceCount: 3,
        localizedDeviceCount: 3,
        rangeCount: 3,
        audioCaptureReadyDeviceCount: 3,
        audioTimestampReadyDeviceCount: 3,
        tdoaSourceCount: 1,
      }),
    );
    expect(result.simulation.maxRangeErrorMeters).toBeLessThan(0.08);
    expect(result.simulation.maxLayoutPairErrorMeters).toBeLessThan(0.15);
    expect(result.simulation.maxSourceDistanceErrorMeters).toBeLessThan(0.35);
  });

  test("writes a simulated passing evidence packet from the CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "blackmagic-sim-trial-"));
    const evidencePath = join(directory, "simulated-evidence.json");

    try {
      const result = spawnSync(
        "npm",
        [
          "run",
          "trial:simulate",
          "--",
          "--out",
          evidencePath,
          "--generated-at-ms",
          "180000",
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
        finalSnapshot: { status: string };
      };

      expect(evidence.passed).toBe(true);
      expect(evidence.finalSnapshot.status).toBe("ready");
      expect(evidence.gates.every((gate) => gate.passed)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
