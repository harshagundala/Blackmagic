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
    expect(report.metrics.acousticPulseDeviceCount).toBe(3);
    expect(report.metrics.acousticObservationDeviceCount).toBe(3);
    expect(report.metrics.sampleAnchoredObservationDeviceCount).toBe(3);
    expect(report.metrics.completeReciprocalExchangeCount).toBeGreaterThanOrEqual(
      3,
    );
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
    expect(report.devices).toHaveLength(3);
    expect(report.devices).toEqual([
      expect.objectContaining({
        deviceId: "host",
        role: "host",
        localized: true,
        captureStatus: "verified",
        audioCaptureReady: true,
        audioTimestampPresent: true,
        audioTimestampReady: true,
        blockers: [],
      }),
      expect.objectContaining({
        deviceId: "phone-a",
        role: "phone",
        localized: true,
        captureStatus: "verified",
        audioCaptureReady: true,
        audioTimestampPresent: true,
        audioTimestampReady: true,
        blockers: [],
      }),
      expect.objectContaining({
        deviceId: "phone-b",
        role: "phone",
        localized: true,
        captureStatus: "verified",
        audioCaptureReady: true,
        audioTimestampPresent: true,
        audioTimestampReady: true,
        blockers: [],
      }),
    ]);
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

  test("reports pairwise acoustic progress for a two-phone room", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-pairwise-progress",
      devices: [
        { deviceId: "host", x: 0, y: 0 },
        { deviceId: "phone-a", x: 2.1, y: 0.2 },
      ],
      exchangesPerPair: 2,
      sampleNoiseStdDev: 0.02,
    });

    const report = validatePhysicalRoomLocalization(
      simulation.roomState,
      simulation.constellation,
    );

    expect(report.pairs).toEqual([
      expect.objectContaining({
        from: "host",
        to: "phone-a",
        status: "ready",
        distanceMeters: expect.closeTo(2.11, 1),
        reciprocalExchangeCount: expect.any(Number),
        fromPulseCount: 2,
        toPulseCount: 2,
        fromSampleAnchoredObservationCount: 4,
        toSampleAnchoredObservationCount: 4,
        missingAnchors: [],
        blockers: [],
      }),
    ]);
    expect(report.pairs[0]?.reciprocalExchangeCount).toBeGreaterThanOrEqual(2);
  });

  test("pinpoints missing reciprocal acoustic anchors in a two-phone room", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-missing-anchors",
      devices: [
        { deviceId: "host", x: 0, y: 0 },
        { deviceId: "phone-a", x: 2.1, y: 0.2 },
      ],
      exchangesPerPair: 1,
      sampleNoiseStdDev: 0.02,
    });
    const missingPhoneObservations = {
      ...simulation.roomState,
      ranges: [],
      devices: simulation.roomState.devices.map((device) =>
        device.deviceId === "phone-a"
          ? {
              ...device,
              acousticObservation: null,
              acousticObservations: [],
            }
          : device,
      ),
    };

    const report = validatePhysicalRoomLocalization(missingPhoneObservations);
    const failingPhone = report.devices.find(
      (device) => device.deviceId === "phone-a",
    );
    const host = report.devices.find((device) => device.deviceId === "host");

    expect(report.phoneLayout.status).toBe("warming");
    expect(report.metrics.rangeCount).toBe(0);
    expect(report.metrics.acousticPulseDeviceCount).toBe(2);
    expect(report.metrics.acousticObservationDeviceCount).toBe(1);
    expect(report.metrics.sampleAnchoredObservationDeviceCount).toBe(1);
    expect(report.metrics.completeReciprocalExchangeCount).toBe(0);
    expect(report.phoneLayout.blockers).toEqual(
      expect.arrayContaining([
        "insufficient_acoustic_ranges",
        "missing_sample_anchored_observations",
        "incomplete_reciprocal_anchors",
      ]),
    );
    expect(report.pairs).toEqual([
      expect.objectContaining({
        from: "host",
        to: "phone-a",
        status: "warming",
        distanceMeters: null,
        reciprocalExchangeCount: 0,
        fromPulseCount: 1,
        toPulseCount: 1,
        fromSampleAnchoredObservationCount: 2,
        toSampleAnchoredObservationCount: 0,
        missingAnchors: expect.arrayContaining([
          "to_sample_anchored_observation",
          "to_heard_from_observation",
          "to_self_observation",
        ]),
        blockers: expect.arrayContaining([
          "no_pairwise_range",
          "missing_pairwise_anchors",
          "incomplete_reciprocal_anchors",
        ]),
      }),
    ]);
    expect(failingPhone).toEqual(
      expect.objectContaining({
        deviceId: "phone-a",
        acousticPulseCount: 1,
        acousticObservationCount: 0,
        sampleAnchoredObservationCount: 0,
      }),
    );
    expect(failingPhone?.blockers).toEqual(
      expect.arrayContaining([
        "not_localized",
        "no_sample_anchored_observation",
      ]),
    );
    expect(host).toEqual(
      expect.objectContaining({
        acousticPulseCount: 1,
        acousticObservationCount: 2,
        sampleAnchoredObservationCount: 2,
      }),
    );
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

  test("identifies the exact phone failing capture and timestamp readiness", () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/lab-device-diagnostics",
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
      devices: simulation.roomState.devices.map((device) =>
        device.deviceId === "phone-a" && device.audioFrame
          ? {
              ...device,
              captureProcessing: {
                echoCancellation: null,
                noiseSuppression: null,
                autoGainControl: null,
                rawCaptureVerified: false,
              },
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
    const failingPhone = report.devices.find(
      (device) => device.deviceId === "phone-a",
    );
    const healthyPhones = report.devices.filter(
      (device) => device.deviceId !== "phone-a",
    );

    expect(failingPhone).toEqual(
      expect.objectContaining({
        deviceId: "phone-a",
        role: "phone",
        mic: "active",
        localized: true,
        captureStatus: "unverified",
        audioCaptureReady: false,
        audioContextState: "running",
        audioTimestampPresent: true,
        audioTimestampReady: false,
        audioTimestampErrorMs: 42,
        audioTimingConfidence: 0.12,
        clockMaxErrorMs: 42,
        clockQuality: 0.98,
        motionStability: 0.96,
      }),
    );
    expect(failingPhone?.blockers).toEqual([
      "audio_capture_unverified",
      "audio_timestamp_error_high",
      "audio_timestamp_confidence_low",
    ]);
    expect(healthyPhones.every((device) => device.blockers.length === 0)).toBe(
      true,
    );
  });
});
