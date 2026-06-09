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
    expect(report.audioCapture.status).toBe("ready");
    expect(report.metrics.audioCaptureReadyDeviceCount).toBe(3);
    expect(report.metrics.rawCaptureVerifiedDeviceCount).toBe(3);
    expect(report.metrics.runningAudioContextDeviceCount).toBe(3);
    expect(report.audioTimestamps.status).toBe("ready");
    expect(report.metrics.audioTimestampReadyDeviceCount).toBe(3);
    expect(report.metrics.worstAudioTimestampErrorMs).toBeLessThanOrEqual(2);
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

  test("marks high-error audio timestamps degraded before trusting localization", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-bad-timestamps",
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
    const degradedRoom = {
      ...simulation.roomState,
      devices: simulation.roomState.devices.map((device, index) =>
        index === 1 && device.audioFrame
          ? {
              ...device,
              audioFrame: {
                ...device.audioFrame,
                clockMaxErrorMs: 42,
                timingConfidence: 0.12,
              },
            }
          : device,
      ),
    };

    const report = validatePhysicalRoomLocalization(
      degradedRoom,
      simulation.constellation,
    );

    expect(report.audioTimestamps.status).toBe("degraded");
    expect(report.status).toBe("degraded");
    expect(report.metrics.audioTimestampReadyDeviceCount).toBe(2);
    expect(report.metrics.worstAudioTimestampErrorMs).toBe(42);
    expect(report.blockers).toContain("audio_timestamp_error_high");
    expect(report.blockers).toContain("audio_timestamp_confidence_low");
  });

  test("marks confirmed filtered audio capture degraded", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-filtered-capture",
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
    const filteredRoom = {
      ...simulation.roomState,
      devices: simulation.roomState.devices.map((device, index) =>
        index === 1
          ? {
              ...device,
              captureProcessing: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: null,
                rawCaptureVerified: false,
              },
            }
          : device,
      ),
    };

    const report = validatePhysicalRoomLocalization(
      filteredRoom,
      simulation.constellation,
    );

    expect(report.audioCapture.status).toBe("degraded");
    expect(report.status).toBe("degraded");
    expect(report.metrics.audioCaptureReadyDeviceCount).toBe(2);
    expect(report.metrics.rawCaptureVerifiedDeviceCount).toBe(2);
    expect(report.blockers).toContain("filtered_audio_capture");
  });

  test("keeps unreported browser capture settings warming instead of degraded", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-unreported-capture",
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
    const unreportedRoom = {
      ...simulation.roomState,
      devices: simulation.roomState.devices.map((device, index) =>
        index === 1
          ? {
              ...device,
              captureProcessing: {
                echoCancellation: null,
                noiseSuppression: null,
                autoGainControl: null,
                rawCaptureVerified: false,
              },
            }
          : device,
      ),
    };

    const report = validatePhysicalRoomLocalization(
      unreportedRoom,
      simulation.constellation,
    );

    expect(report.audioCapture.status).toBe("warming");
    expect(report.status).toBe("warming");
    expect(report.metrics.audioCaptureReadyDeviceCount).toBe(2);
    expect(report.metrics.rawCaptureVerifiedDeviceCount).toBe(2);
    expect(report.metrics.unverifiedCaptureDeviceCount).toBe(1);
    expect(report.metrics.filteredCaptureDeviceCount).toBe(0);
    expect(report.blockers).toContain("audio_capture_unverified");
    expect(report.blockers).not.toContain("filtered_audio_capture");
  });
});
