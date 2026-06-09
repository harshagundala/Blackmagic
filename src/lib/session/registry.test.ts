import { describe, expect, test } from "vitest";
import { createSessionRegistry, type DeviceHeartbeat } from "./registry";

describe("session registry", () => {
  test("makes the first device at a URL the host", () => {
    const registry = createSessionRegistry();

    expect(registry.claim("https://blackmagic.app/", "a").role).toBe("host");
    expect(registry.claim("https://blackmagic.app/", "b").role).toBe("phone");
    expect(registry.claim("https://blackmagic.app/", "a").role).toBe("host");
  });

  test("keeps different URLs isolated", () => {
    const registry = createSessionRegistry();

    expect(registry.claim("https://blackmagic.app/", "a").role).toBe("host");
    expect(registry.claim("https://blackmagic.app/alpha", "b").role).toBe("host");
  });

  test("tracks mutation revisions separately from read timestamps", () => {
    let now = 100;
    const registry = createSessionRegistry({ now: () => now });

    registry.claim("https://blackmagic.app/", "host");
    now = 150;
    const firstRead = registry.state("https://blackmagic.app/");
    now = 200;
    const secondRead = registry.state("https://blackmagic.app/");

    expect(firstRead.revision).toBeGreaterThan(0);
    expect(firstRead.changedAt).toBe(100);
    expect(firstRead.updatedAt).toBe(150);
    expect(secondRead.revision).toBe(firstRead.revision);
    expect(secondRead.changedAt).toBe(firstRead.changedAt);
    expect(secondRead.updatedAt).toBe(200);

    now = 250;
    const heartbeatState = registry.heartbeat("https://blackmagic.app/", "host", {
      micLevel: 0.2,
    });

    expect(heartbeatState.revision).toBeGreaterThan(secondRead.revision);
    expect(heartbeatState.changedAt).toBe(250);
  });

  test("publishes the next calibration turn from the room state clock", () => {
    const registry = createSessionRegistry({ now: () => 100 });

    registry.claim("https://blackmagic.app/", "host");
    expect(registry.state("https://blackmagic.app/").calibrationTurn).toBeNull();

    registry.heartbeat("https://blackmagic.app/", "host", {
      mic: "active",
      audioFrame: audioFrame(),
    });
    registry.heartbeat("https://blackmagic.app/", "phone-a", {
      mic: "active",
      audioFrame: audioFrame(),
    });

    expect(registry.state("https://blackmagic.app/").calibrationTurn).toEqual({
      emitterId: "host",
      sequence: 0,
      slotStartsAtHostEpochMs: 0,
      pulseEmittedAtHostEpochMs: 3_400,
      pulseDurationMs: 48,
    });
  });

  test("waits for two capture-ready devices before publishing calibration turns", () => {
    const registry = createSessionRegistry({ now: () => 100 });

    registry.heartbeat("https://blackmagic.app/", "host", {
      mic: "active",
      audioFrame: audioFrame(),
    });
    registry.claim("https://blackmagic.app/", "phone-a");

    expect(registry.state("https://blackmagic.app/").calibrationTurn).toBeNull();
  });

  test("summarizes room time sync health for localization gating", () => {
    const registry = createSessionRegistry({ now: () => 10_000 });

    registry.heartbeat("https://blackmagic.app/", "host", {
      clockQuality: 0.96,
      clockUncertaintyMs: 3,
      clockMaxErrorMs: 4,
      clockBestRoundTripMs: 14,
      clockJitterMs: 0.8,
      clockSamplesUsed: 8,
      clockOffsetStabilityMs: 0.7,
    });
    registry.heartbeat("https://blackmagic.app/", "phone-a", {
      clockQuality: 0.91,
      clockUncertaintyMs: 4,
      clockMaxErrorMs: 5,
      clockBestRoundTripMs: 18,
      clockJitterMs: 1.2,
      clockSamplesUsed: 7,
      clockOffsetStabilityMs: 1,
    });
    registry.heartbeat("https://blackmagic.app/", "phone-b", {
      clockQuality: 0.28,
      clockUncertaintyMs: 55,
      clockMaxErrorMs: 80,
      clockBestRoundTripMs: 260,
      clockJitterMs: 18,
      clockSamplesUsed: 2,
      clockOffsetStabilityMs: 20,
    });

    const state = registry.state("https://blackmagic.app/");

    expect(state.timeSync).toEqual(
      expect.objectContaining({
        status: "ready",
        synchronizedDeviceIds: ["host", "phone-a"],
        localizationDeviceIds: ["host", "phone-a"],
        medianMaxErrorMs: 5,
        worstLocalizationErrorMs: 5,
      }),
    );
    expect(state.timeSync.devices).toEqual([
      expect.objectContaining({
        deviceId: "host",
        localizationReady: true,
        synchronized: true,
      }),
      expect.objectContaining({
        deviceId: "phone-a",
        localizationReady: true,
        synchronized: true,
      }),
      expect.objectContaining({
        deviceId: "phone-b",
        localizationReady: false,
        synchronized: false,
      }),
    ]);
  });

  test("tracks active device heartbeats with sensor and timing summaries", () => {
    const registry = createSessionRegistry({ now: () => 10_000 });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");
    const state = registry.heartbeat("https://blackmagic.app/", "phone-a", {
      mic: "active",
      micLevel: 0.08,
      sampleRate: 48_000,
      clockQuality: 0.92,
      clockOffsetMs: -3.5,
      clockUncertaintyMs: 6,
      clockMaxErrorMs: 7.2,
      clockBestRoundTripMs: 12,
      clockJitterMs: 1.2,
      clockSamplesUsed: 5,
      audioFrame: {
        audioContextTimeSeconds: 10,
        sampleIndex: 480_000,
        sampleRate: 48_000,
        clientPerfOriginEpochMs: 1_700_000_000_000,
        performanceNowMs: 2_000,
        clockOffsetMs: 2,
        clockUncertaintyMs: 6,
        clockQuality: 0.92,
        clockMaxErrorMs: 7.2,
        clockBestRoundTripMs: 12,
        clockJitterMs: 1.2,
        clockSamplesUsed: 5,
        clockOutliersRejected: 1,
        clockOffsetStabilityMs: 0.9,
        audioElapsedMs: 10_000,
        hostEstimatedEpochMs: 1_700_000_002_002,
        timingConfidence: 0.74,
      },
      motion: "active",
      heading: "idle",
      location: "blocked",
      acousticPulse: {
        id: "chirp-1",
        emittedAtHostEpochMs: 10_500,
        emittedSampleIndex: 504_000,
        sampleRate: 48_000,
        durationMs: 48,
        frequencyHz: 17_200,
        endFrequencyHz: 19_200,
      },
      voiceEvent: {
        id: "voice-phone-a",
        detectedAtHostEpochMs: 10_250,
        audioContextTimeSeconds: 10.2,
        sampleIndex: 489_600,
        sampleRate: 48_000,
        audioLevel: 0.08,
        confidence: 0.82,
        clockOffsetMs: 2,
        clockUncertaintyMs: 6,
        clockQuality: 0.92,
        clockMaxErrorMs: 7.2,
        clockBestRoundTripMs: 12,
        clockJitterMs: 1.2,
        clockSamplesUsed: 5,
        clockOutliersRejected: 1,
        clockOffsetStabilityMs: 0.9,
        timingConfidence: 0.74,
      },
    });

    expect(state.devices).toEqual([
      expect.objectContaining({ deviceId: "host", role: "host" }),
      expect.objectContaining({
        deviceId: "phone-a",
        role: "phone",
        mic: "active",
        micLevel: 0.08,
        sampleRate: 48_000,
        clockQuality: 0.92,
        clockOffsetMs: -3.5,
        clockMaxErrorMs: 7.2,
        clockBestRoundTripMs: 12,
        clockJitterMs: 1.2,
        clockSamplesUsed: 5,
        acousticPulse: expect.objectContaining({
          id: "chirp-1",
          frequencyHz: 17_200,
          endFrequencyHz: 19_200,
          emittedSampleIndex: 504_000,
          sampleRate: 48_000,
        }),
        audioFrame: expect.objectContaining({
          sampleIndex: 480_000,
          hostEstimatedEpochMs: 1_700_000_002_002,
          clockUncertaintyMs: 6,
          clockQuality: 0.92,
          clockBestRoundTripMs: 12,
          clockSamplesUsed: 5,
          clockOutliersRejected: 1,
        }),
        voiceEvent: expect.objectContaining({
          id: "voice-phone-a",
          sampleIndex: 489_600,
          detectedAtHostEpochMs: 10_250,
          clockBestRoundTripMs: 12,
          clockSamplesUsed: 5,
          clockOutliersRejected: 1,
          timingConfidence: 0.74,
        }),
      }),
    ]);
  });

  test("reconciles near-simultaneous voice events into room audio events", () => {
    const registry = createSessionRegistry({ now: () => 20_000 });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");
    registry.heartbeat("https://blackmagic.app/", "host", {
      voiceEvent: {
        id: "voice-host",
        detectedAtHostEpochMs: 18_000,
        audioContextTimeSeconds: 20,
        sampleIndex: 960_000,
        sampleRate: 48_000,
        audioLevel: 0.09,
        confidence: 0.85,
        clockOffsetMs: 1,
        clockUncertaintyMs: 3,
        clockQuality: 0.95,
      },
    });
    const state = registry.heartbeat("https://blackmagic.app/", "phone-a", {
      voiceEvent: {
        id: "voice-phone-a",
        detectedAtHostEpochMs: 18_008,
        audioContextTimeSeconds: 20.008,
        sampleIndex: 960_384,
        sampleRate: 48_000,
        audioLevel: 0.07,
        confidence: 0.78,
        clockOffsetMs: 2,
        clockUncertaintyMs: 4,
        clockQuality: 0.94,
      },
    });

    expect(state.audioEvents).toEqual([
      expect.objectContaining({
        arrivalLeaderDeviceId: "host",
        observedDeviceIds: ["host", "phone-a"],
        startedAtHostEpochMs: 18_000,
        endedAtHostEpochMs: 18_008,
      }),
    ]);
  });

  test("preserves quantitative motion heading and location metadata", () => {
    const registry = createSessionRegistry({ now: () => 30_000 });

    registry.claim("https://blackmagic.app/", "host");
    const heartbeat: DeviceHeartbeat = {
      motion: "active",
      motionAccelerationMagnitude: 0.42,
      motionRotationRateDegPerSec: 3.5,
      motionIntervalMs: 16.7,
      motionStability: 0.88,
      heading: "active",
      headingDegrees: 281.4,
      orientationBetaDegrees: -12.5,
      orientationGammaDegrees: 4.25,
      orientationAbsolute: true,
      location: "active",
      locationLatitude: 37.8715,
      locationLongitude: -122.273,
      locationAccuracyMeters: 8.4,
      locationAltitudeMeters: 51.2,
      locationAltitudeAccuracyMeters: 12.5,
      locationHeadingDegrees: 279,
      locationSpeedMetersPerSecond: 0.12,
      locationCapturedAtEpochMs: 1_780_996_000_000,
    };

    const state = registry.heartbeat(
      "https://blackmagic.app/",
      "host",
      heartbeat,
    );

    expect(state.devices[0]).toEqual(
      expect.objectContaining({
        motionAccelerationMagnitude: 0.42,
        motionRotationRateDegPerSec: 3.5,
        motionIntervalMs: 16.7,
        motionStability: 0.88,
        headingDegrees: 281.4,
        orientationBetaDegrees: -12.5,
        orientationGammaDegrees: 4.25,
        orientationAbsolute: true,
        locationLatitude: 37.8715,
        locationLongitude: -122.273,
        locationAccuracyMeters: 8.4,
        locationAltitudeMeters: 51.2,
        locationAltitudeAccuracyMeters: 12.5,
        locationHeadingDegrees: 279,
        locationSpeedMetersPerSecond: 0.12,
        locationCapturedAtEpochMs: 1_780_996_000_000,
      }),
    );
  });

  test("preserves compact voice fingerprints through heartbeat sanitization", () => {
    const registry = createSessionRegistry({ now: () => 41_000 });

    const state = registry.heartbeat("https://blackmagic.app/", "host", {
      voiceEvent: {
        id: "voice-with-fingerprint",
        detectedAtHostEpochMs: 40_000,
        audioContextTimeSeconds: 12,
        sampleIndex: 576_000,
        sampleRate: 48_000,
        audioLevel: 0.08,
        confidence: 0.84,
        clockOffsetMs: 1,
        clockUncertaintyMs: 3,
        clockQuality: 0.96,
        audioFingerprint: {
          sampleRate: 1_000,
          startSampleIndex: 120,
          centerSampleIndex: 200,
          hopMs: 5,
          windowMs: 80,
          values: [0, 0.1, 0.35, 1, 0.7, 0.28, 0.1, 0],
          alignmentHopMs: 2,
          alignmentWindowMs: 24,
          alignmentValues: [0, 0.2, 0.8, 1, 0.6, -0.2, -0.8, -1],
        },
      },
    });

    expect(state.devices[0].voiceEvent).toEqual(
      expect.objectContaining({
        id: "voice-with-fingerprint",
        audioFingerprint: expect.objectContaining({
          hopMs: 5,
          windowMs: 80,
          values: [0, 0.1, 0.35, 1, 0.7, 0.28, 0.1, 0],
          alignmentHopMs: 2,
          alignmentWindowMs: 24,
          alignmentValues: [0, 0.2, 0.8, 1, 0.6, -0.2, -0.8, -1],
        }),
      }),
    );
  });

  test("keeps bounded acoustic pulse and observation histories across heartbeats", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");

    for (let index = 0; index < 10; index += 1) {
      now += 100;
      registry.heartbeat("https://blackmagic.app/", "host", {
        acousticPulse: {
          id: `pulse-${index}`,
          emittedAtHostEpochMs: 10_000 + index * 1_000,
          emittedSampleIndex: 480_000 + index * 48_000,
          sampleRate: 48_000,
          durationMs: 48,
          frequencyHz: 17_200,
          endFrequencyHz: 19_200,
        },
      });
      registry.heartbeat("https://blackmagic.app/", "phone-a", {
        acousticObservation: {
          pulseId: `pulse-${index}`,
          detectedAtHostEpochMs: 10_006 + index * 1_000,
          detectedSampleIndex: 960_000 + index * 48_000,
          sampleRate: 48_000,
          amplitude: 0.3,
          confidence: 0.8,
          clockUncertaintyMs: 2,
        },
      });
    }

    const state = registry.state("https://blackmagic.app/");
    const host = state.devices.find((device) => device.deviceId === "host");
    const phone = state.devices.find((device) => device.deviceId === "phone-a");

    expect(host?.acousticPulses?.map((pulse) => pulse.id)).toEqual([
      "pulse-2",
      "pulse-3",
      "pulse-4",
      "pulse-5",
      "pulse-6",
      "pulse-7",
      "pulse-8",
      "pulse-9",
    ]);
    expect(host?.acousticPulses?.at(-1)).toEqual(
      expect.objectContaining({
        emittedSampleIndex: 912_000,
        sampleRate: 48_000,
      }),
    );
    expect(phone?.acousticObservations?.map((observation) => observation.pulseId)).toEqual([
      "pulse-2",
      "pulse-3",
      "pulse-4",
      "pulse-5",
      "pulse-6",
      "pulse-7",
      "pulse-8",
      "pulse-9",
    ]);
    expect(phone?.acousticObservations?.at(-1)).toEqual(
      expect.objectContaining({
        detectedSampleIndex: 1_392_000,
        sampleRate: 48_000,
      }),
    );
    expect(state.ranges).toEqual([]);
  });

  test("prunes stale non-host phones while keeping an active host", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now, staleAfterMs: 5_000 });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");
    registry.heartbeat("https://blackmagic.app/", "phone-a", { micLevel: 0.1 });
    now = 4_000;
    registry.heartbeat("https://blackmagic.app/", "host", { micLevel: 0.1 });
    now = 8_000;

    const state = registry.state("https://blackmagic.app/");

    expect(state.devices.map((device) => device.deviceId)).toEqual(["host"]);
  });

  test("releases a stale host so the next active device becomes host", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now, staleAfterMs: 5_000 });

    registry.claim("https://blackmagic.app/", "host");
    now = 8_000;

    expect(registry.claim("https://blackmagic.app/", "next").role).toBe("host");
    expect(registry.state("https://blackmagic.app/")).toEqual(
      expect.objectContaining({
        hostDeviceId: "next",
        devices: [expect.objectContaining({ deviceId: "next", role: "host" })],
      }),
    );
  });

  test("promotes the oldest active phone when the host goes stale", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now, staleAfterMs: 5_000 });

    registry.claim("https://blackmagic.app/", "host");
    now = 2_000;
    registry.claim("https://blackmagic.app/", "phone-a");
    now = 7_000;
    registry.heartbeat("https://blackmagic.app/", "phone-a", { micLevel: 0.1 });
    now = 8_000;

    const state = registry.state("https://blackmagic.app/");

    expect(state.hostDeviceId).toBe("phone-a");
    expect(state.devices).toEqual([
      expect.objectContaining({ deviceId: "phone-a", role: "host" }),
    ]);
  });
});

function audioFrame() {
  return {
    audioContextTimeSeconds: 1,
    sampleIndex: 48_000,
    sampleRate: 48_000,
    clientPerfOriginEpochMs: 1_700_000_000_000,
    performanceNowMs: 1_000,
    clockOffsetMs: 0,
    clockUncertaintyMs: 2,
    clockQuality: 0.98,
    clockMaxErrorMs: 3,
    clockBestRoundTripMs: 6,
    clockJitterMs: 0.3,
    clockSamplesUsed: 8,
    clockOutliersRejected: 0,
    clockOffsetStabilityMs: 0.3,
    audioElapsedMs: 1_000,
    hostEstimatedEpochMs: 1_700_000_001_000,
    timingConfidence: 0.88,
  };
}
