import { describe, expect, test } from "vitest";
import {
  clockExchangeFromProbeAck,
  createClockProbeAckMessage,
  createClockProbeMessage,
  createRealtimeSensorFrame,
  createVoiceEventMessage,
  parseRealtimeDataChannelMessage,
  serializeRealtimeDataChannelMessage,
} from "./data-channel";
import { estimateClockOffset } from "../timing/clock-sync";

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

  test("stamps probe acks with the responder's wall-clock epoch instants", () => {
    const probe = createClockProbeMessage({
      id: "clock-phone-a-7",
      fromDeviceId: "phone-a",
      sentAtClientPerfMs: 5_000,
    });
    const ack = createClockProbeAckMessage({
      probe,
      fromDeviceId: "host-device",
      probeReceivedAtClientPerfMs: 9_000,
      ackSentAtClientPerfMs: 9_001,
      perfOriginEpochMs: 1_800_000_000_000,
      hostEstimatedEpochMs: 1_800_000_009_002,
    });

    expect(ack.probeReceivedAtEpochMs).toBe(1_800_000_009_000);
    expect(ack.ackSentAtEpochMs).toBe(1_800_000_009_001);
    expect(parseRealtimeDataChannelMessage(JSON.stringify(ack))).toEqual(ack);
  });

  test("converts a completed probe round trip into a host clock exchange", () => {
    const probe = createClockProbeMessage({
      id: "clock-phone-a-8",
      fromDeviceId: "phone-a",
      sentAtClientPerfMs: 1_000,
    });
    // The host clock runs 250 ms ahead of the prober; one-way latency 6 ms,
    // 2 ms of host processing between receive and ack. The host stamped perf
    // 50_006 at the physical instant the prober's perf clock read 1_006, so
    // its origin is prober-origin - 49_000 + 250.
    const ack = createClockProbeAckMessage({
      probe,
      fromDeviceId: "host-device",
      probeReceivedAtClientPerfMs: 50_006,
      ackSentAtClientPerfMs: 50_008,
      perfOriginEpochMs: 1_800_000_000_000 - 1_000 - 49_000 + 250,
    });

    const exchange = clockExchangeFromProbeAck({
      ack,
      receivedAtClientPerfMs: 1_014,
      clientPerfOriginEpochMs: 1_800_000_000_000 - 1_000,
    });

    expect(exchange).not.toBeNull();
    expect(exchange?.serverInstanceId).toBe("peer:host-device");
    const estimate = estimateClockOffset(exchange!);
    expect(estimate.offsetMs).toBeCloseTo(250, 3);
    expect(estimate.roundTripMs).toBeCloseTo(12, 3);
  });

  test("refuses probe acks that cannot form a sane exchange", () => {
    const probe = createClockProbeMessage({
      id: "clock-phone-a-9",
      fromDeviceId: "phone-a",
      sentAtClientPerfMs: 1_000,
    });
    const ack = createClockProbeAckMessage({
      probe,
      fromDeviceId: "host-device",
      probeReceivedAtClientPerfMs: 2_000,
      ackSentAtClientPerfMs: 2_001,
      perfOriginEpochMs: Number.NaN,
    });

    expect(
      clockExchangeFromProbeAck({
        ack,
        receivedAtClientPerfMs: 1_020,
        clientPerfOriginEpochMs: 0,
      }),
    ).toBeNull();
    expect(
      clockExchangeFromProbeAck({
        ack: {
          ...ack,
          probeReceivedAtEpochMs: 5_000,
          ackSentAtEpochMs: 5_001,
        },
        // Arrived before it was sent: clock nonsense, reject.
        receivedAtClientPerfMs: 900,
        clientPerfOriginEpochMs: 0,
      }),
    ).toBeNull();
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

  test("round-trips voice events carrying audio snippets", () => {
    const message = createVoiceEventMessage({
      fromDeviceId: "phone-a",
      event: {
        id: "voice-103200-1800000002150",
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
          encodedSamples: "QUJDRA==",
        },
      },
    });
    expect(message).not.toBeNull();
    const encoded = serializeRealtimeDataChannelMessage(message!);
    expect(parseRealtimeDataChannelMessage(encoded)).toEqual(message);
  });

  test("rejects voice events with corrupt snippets or missing timing", () => {
    expect(
      parseRealtimeDataChannelMessage(
        JSON.stringify({
          type: "voice-event",
          version: 1,
          fromDeviceId: "phone-a",
          event: { id: "voice-1" },
        }),
      ),
    ).toBeNull();
    expect(
      parseRealtimeDataChannelMessage(
        JSON.stringify({
          type: "voice-event",
          version: 1,
          fromDeviceId: "phone-a",
          event: {
            id: "voice-1",
            detectedAtHostEpochMs: 1,
            sampleIndex: 2,
            sampleRate: 48_000,
            confidence: 0.5,
            audioSnippet: { encodedSamples: "not base64 ***" },
          },
        }),
      ),
    ).toBeNull();
  });

  test("round-trips reconciliation state broadcasts", () => {
    const message = {
      type: "reconciliation-state" as const,
      version: 1 as const,
      fromDeviceId: "host-device",
      updatedAtHostEpochMs: 1_800_000_010_000,
      ranges: [
        {
          from: "host-device",
          to: "phone-b",
          meters: 2.13,
          uncertaintyMeters: 0.21,
          coverage: 0.8,
          confidence: 0.74,
          samplesUsed: 41,
        },
      ],
      points: {
        "host-device": { x: 0, y: 0 },
        "phone-b": { x: 2.1, y: 0.1 },
      },
      layoutQuality: 0.9,
      talker: {
        x: 1.4,
        y: 0.8,
        residualMs: 0.21,
        confidence: 0.65,
        atHostEpochMs: 1_800_000_009_400,
      },
    };
    const encoded = serializeRealtimeDataChannelMessage(message);
    expect(parseRealtimeDataChannelMessage(encoded)).toEqual(message);
  });

  test("rejects reconciliation state with non-finite geometry", () => {
    expect(
      parseRealtimeDataChannelMessage(
        JSON.stringify({
          type: "reconciliation-state",
          version: 1,
          fromDeviceId: "host-device",
          updatedAtHostEpochMs: 1,
          ranges: [],
          points: { a: { x: null, y: 0 } },
          layoutQuality: null,
          talker: null,
        }),
      ),
    ).toBeNull();
  });
});
