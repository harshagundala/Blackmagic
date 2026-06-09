import { describe, expect, test } from "vitest";
import {
  createDeviceHeartbeatPayload,
  acknowledgedVoiceEventId,
} from "./heartbeat-payload";

describe("heartbeat payload", () => {
  test("includes a new voice event until it has been acknowledged", () => {
    const snapshot = sensorSnapshot({ voiceEvent: voiceEvent("voice-1") });

    const first = createDeviceHeartbeatPayload({
      snapshot,
      calibration: {},
      lastPublishedVoiceEventId: "",
    });
    const repeated = createDeviceHeartbeatPayload({
      snapshot,
      calibration: {},
      lastPublishedVoiceEventId: "voice-1",
    });

    expect(first.voiceEvent?.id).toBe("voice-1");
    expect(acknowledgedVoiceEventId(first, "")).toBe("voice-1");
    expect(repeated.voiceEvent).toBeNull();
    expect(repeated.audioFrame).toBe(snapshot.audioFrame);
    expect(repeated.motionStability).toBe(snapshot.motionStability);
  });

  test("keeps calibration evidence even when a voice event is deduped", () => {
    const pulse = {
      id: "pulse-1",
      emittedAtHostEpochMs: 12_000,
      durationMs: 48,
      frequencyHz: 17_200,
      endFrequencyHz: 19_200,
      sampleRate: 48_000,
    };

    const heartbeat = createDeviceHeartbeatPayload({
      snapshot: sensorSnapshot({ voiceEvent: voiceEvent("voice-1") }),
      calibration: { acousticPulse: pulse },
      lastPublishedVoiceEventId: "voice-1",
    });

    expect(heartbeat.voiceEvent).toBeNull();
    expect(heartbeat.acousticPulse).toEqual(pulse);
  });
});

function sensorSnapshot(
  overrides: Partial<Parameters<typeof createDeviceHeartbeatPayload>[0]["snapshot"]> = {},
): Parameters<typeof createDeviceHeartbeatPayload>[0]["snapshot"] {
  return {
    mic: "active",
    motion: "active",
    heading: "active",
    location: "active",
    micLevel: 0.08,
    sampleRate: 48_000,
    audioFrame: {
      sampleIndex: 960_000,
      sampleRate: 48_000,
      audioContextTimeSeconds: 20,
      performanceNowMs: 10_000,
      clientPerfOriginEpochMs: 1_700_000_000_000,
      clockOffsetMs: 2,
      clockUncertaintyMs: 3,
      clockQuality: 0.96,
      clockMaxErrorMs: 4,
      clockBestRoundTripMs: 12,
      clockJitterMs: 0.7,
      clockSamplesUsed: 8,
      clockOutliersRejected: 0,
      clockOffsetStabilityMs: 0.5,
      timingConfidence: 0.88,
      hostEstimatedEpochMs: 1_700_000_010_002,
    },
    audioWindow: null,
    pulseObservation: null,
    voiceEvent: null,
    headingDegrees: 280,
    orientationBetaDegrees: 2,
    orientationGammaDegrees: -1,
    orientationAbsolute: true,
    locationLatitude: 37.8715,
    locationLongitude: -122.273,
    locationAccuracyMeters: 9,
    locationAltitudeMeters: 50,
    locationAltitudeAccuracyMeters: 12,
    locationHeadingDegrees: 281,
    locationSpeedMetersPerSecond: 0.1,
    locationCapturedAtEpochMs: 1_700_000_010_000,
    clock: {
      offsetMs: 2,
      uncertaintyMs: 3,
      quality: 0.96,
      maxErrorMs: 4,
      bestRoundTripMs: 12,
      jitterMs: 0.7,
      samplesUsed: 8,
      outliersRejected: 0,
      offsetStabilityMs: 0.5,
      serverInstanceId: "iad1",
    },
    captureProcessing: null,
    audioContextState: "running",
    motionAccelerationX: 0,
    motionAccelerationY: 0,
    motionAccelerationZ: 0,
    motionAccelerationIncludingGravityX: 0,
    motionAccelerationIncludingGravityY: 0,
    motionAccelerationIncludingGravityZ: 9.8,
    motionAccelerationMagnitude: 0.03,
    motionRotationAlpha: 0,
    motionRotationBeta: 0,
    motionRotationGamma: 0,
    motionRotationRateDegPerSec: 0.2,
    motionIntervalMs: 16.7,
    motionCapturedAtClientPerfMs: 10_000,
    motionStability: 0.94,
    ...overrides,
  };
}

function voiceEvent(id: string) {
  return {
    id,
    detectedAtHostEpochMs: 1_700_000_010_000,
    audioContextTimeSeconds: 20,
    sampleIndex: 960_000,
    sampleRate: 48_000,
    audioLevel: 0.08,
    confidence: 0.82,
    clockOffsetMs: 2,
    clockUncertaintyMs: 3,
  };
}
