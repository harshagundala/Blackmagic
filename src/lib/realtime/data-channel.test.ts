import { describe, expect, test } from "vitest";
import {
  createClockProbeMessage,
  createRealtimeSensorFrame,
  parseRealtimeDataChannelMessage,
  serializeRealtimeDataChannelMessage,
} from "./data-channel";

describe("realtime data channel messages", () => {
  test("serializes sensor metadata frames without raw audio payloads", () => {
    const frame = createRealtimeSensorFrame({
      deviceId: "phone-a",
      sequence: 4,
      sentAtClientPerfMs: 123.4,
      snapshot: {
        micLevel: 0.42,
        sampleRate: 48_000,
        audioFrame: {
          audioContextTimeSeconds: 2,
          sampleIndex: 96_000,
          sampleRate: 48_000,
          clientPerfOriginEpochMs: 1_800_000_000_000,
          performanceNowMs: 2_000,
          clockOffsetMs: 3.2,
          clockUncertaintyMs: 1.7,
          audioElapsedMs: 2_000,
          hostEstimatedEpochMs: 1_800_000_002_003.2,
          timingConfidence: 0.92,
        },
        audioWindow: {
          sampleRate: 48_000,
          startSampleIndex: 1,
          samples: new Float32Array([0.1, -0.1]),
        },
        pulseObservation: {
          pulseId: "pulse-host-1",
          detectedAtHostEpochMs: 1_800_000_002_120,
          detectedSampleIndex: 96_120,
          sampleRate: 48_000,
          amplitude: 0.7,
          confidence: 0.82,
          clockUncertaintyMs: 1.7,
        },
        voiceEvent: {
          id: "voice-1",
          detectedAtHostEpochMs: 1_800_000_002_150,
          audioContextTimeSeconds: 2.15,
          sampleIndex: 103_200,
          sampleRate: 48_000,
          audioLevel: 0.32,
          confidence: 0.76,
          clockOffsetMs: 3.2,
          clockUncertaintyMs: 1.7,
          audioSnippet: {
            sampleRate: 8_000,
            sourceSampleRate: 48_000,
            startSampleIndex: 102_000,
            centerSampleIndex: 103_200,
            windowMs: 240,
            peakLevel: 0.6,
            encodedSamples: "SHOULD_NOT_LEAK",
          },
        },
        clock: {
          offsetMs: 3.2,
          uncertaintyMs: 1.7,
          quality: 0.92,
          maxErrorMs: 2.2,
          bestRoundTripMs: 8,
          jitterMs: 0.4,
          samplesUsed: 10,
          outliersRejected: 1,
          offsetStabilityMs: 0.5,
          updatedAtClientPerfMs: 2_000,
        },
        headingDegrees: 43,
        motionStability: 0.74,
        motionRotationRateDegPerSec: 8.5,
        motionCapturedAtClientPerfMs: 122.8,
      },
    });

    const encoded = serializeRealtimeDataChannelMessage(frame);

    expect(frame).toEqual(
      expect.objectContaining({
        type: "sensor-frame",
        version: 1,
        fromDeviceId: "phone-a",
        sequence: 4,
        micLevel: 0.42,
        headingDegrees: 43,
        motionStability: 0.74,
        pulseObservation: expect.objectContaining({
          pulseId: "pulse-host-1",
        }),
      }),
    );
    expect(encoded).not.toContain("audioWindow");
    expect(encoded).not.toContain('"samples"');
    expect(encoded).not.toContain("SHOULD_NOT_LEAK");
    expect(parseRealtimeDataChannelMessage(encoded)).toEqual(frame);
  });

  test("round-trips clock probes used for peer-to-peer sync", () => {
    const probe = createClockProbeMessage({
      id: "clock-phone-a-1",
      fromDeviceId: "phone-a",
      sentAtClientPerfMs: 1_234.5,
      hostEstimatedEpochMs: 1_800_000_001_234.5,
    });

    expect(parseRealtimeDataChannelMessage(JSON.stringify(probe))).toEqual({
      type: "clock-probe",
      version: 1,
      id: "clock-phone-a-1",
      fromDeviceId: "phone-a",
      sentAtClientPerfMs: 1_234.5,
      hostEstimatedEpochMs: 1_800_000_001_234.5,
    });
  });

  test("rejects malformed or oversized data channel payloads", () => {
    expect(parseRealtimeDataChannelMessage("{")).toBeNull();
    expect(
      parseRealtimeDataChannelMessage(
        JSON.stringify({ type: "sensor-frame", version: 2 }),
      ),
    ).toBeNull();
    expect(parseRealtimeDataChannelMessage("x".repeat(70_000))).toBeNull();
  });
});
