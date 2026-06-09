import { describe, expect, test } from "vitest";
import { simulateAcousticRoom } from "./acoustic-room-simulator";
import { validatePhysicalRoomLocalization } from "./physical-room-validation";

describe("physical room validation", () => {
  test("marks a synchronized three-phone spoken-source simulation ready", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-validation",
      devices: [
        { deviceId: "host", x: 0, y: 0 },
        { deviceId: "phone-a", x: 2.2, y: 0.25 },
        { deviceId: "phone-b", x: 0.65, y: 2.15 },
      ],
      exchangesPerPair: 3,
      sampleNoiseStdDev: 0.08,
      speechEvents: [
        {
          id: "speaker-1",
          x: -0.5,
          y: -0.35,
          emittedAtHostEpochMs: 118_000,
        },
      ],
      voiceNoiseMs: 0.04,
    });

    const report = validatePhysicalRoomLocalization(
      simulation.roomState,
      simulation.constellation,
    );

    expect(simulation.validation.status).toBe("ready");
    expect(report.status).toBe("ready");
    expect(report.phoneLayout.status).toBe("ready");
    expect(report.spokenSource.status).toBe("ready");
    expect(report.blockers).toEqual([]);
    expect(report.metrics.deviceCount).toBe(3);
    expect(report.metrics.localizedDeviceCount).toBe(3);
    expect(report.metrics.rangeCount).toBe(3);
    expect(report.metrics.tdoaSourceCount).toBe(1);
    expect(report.metrics.worstClockErrorMs).toBeLessThanOrEqual(2);
    expect(report.metrics.bestSourceResidualMs).toBeLessThan(3);
  });

  test("surfaces blockers when geometry exists but source evidence is missing", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-no-source",
      devices: [
        { deviceId: "host", x: 0, y: 0 },
        { deviceId: "phone-a", x: 2.2, y: 0.25 },
        { deviceId: "phone-b", x: 0.65, y: 2.15 },
      ],
      exchangesPerPair: 3,
      sampleNoiseStdDev: 0.08,
    });

    const report = validatePhysicalRoomLocalization(
      simulation.roomState,
      simulation.constellation,
    );

    expect(report.phoneLayout.status).toBe("ready");
    expect(report.spokenSource.status).toBe("warming");
    expect(report.status).toBe("warming");
    expect(report.blockers).toContain("no_tdoa_source");
  });

  test("marks high-error spoken-source evidence degraded", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-bad-source-fit",
      devices: [
        { deviceId: "host", x: 0, y: 0 },
        { deviceId: "phone-a", x: 2.2, y: 0.25 },
        { deviceId: "phone-b", x: 0.65, y: 2.15 },
      ],
      exchangesPerPair: 3,
      speechEvents: [
        {
          id: "speaker-1",
          x: -0.5,
          y: -0.35,
        },
      ],
    });
    const report = validatePhysicalRoomLocalization(simulation.roomState, {
      ...simulation.constellation,
      audioSources: simulation.constellation.audioSources.map((source) => ({
        ...source,
        residualMs: 12,
      })),
    });

    expect(report.spokenSource.status).toBe("degraded");
    expect(report.status).toBe("degraded");
    expect(report.blockers).toContain("source_residual_high");
  });
});
