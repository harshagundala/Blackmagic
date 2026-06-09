import { describe, expect, test } from "vitest";
import {
  detectVoiceActivityEvent,
  type VoiceActivityGate,
} from "./voice-activity";
import type { AudioFrameTimestamp } from "@/lib/timing/clock-sync";

describe("voice activity gate", () => {
  test("emits a timestamped event on a rising energy edge", () => {
    const gate: VoiceActivityGate = {
      open: false,
      lastEventHostEpochMs: null,
    };

    const result = detectVoiceActivityEvent({
      gate,
      micLevel: 0.075,
      frame: audioFrame({ hostEstimatedEpochMs: 1_780_000_100_000 }),
    });

    expect(result.event).toEqual(
      expect.objectContaining({
        id: "voice-600000-1780000100000",
        detectedAtHostEpochMs: 1_780_000_100_000,
        sampleIndex: 600_000,
        sampleRate: 48_000,
        audioLevel: 0.075,
        confidence: expect.any(Number),
        clockUncertaintyMs: 4,
        clockMaxErrorMs: 4,
        clockBestRoundTripMs: 8,
        clockJitterMs: 0.5,
        clockSamplesUsed: 8,
        clockOutliersRejected: 1,
        clockOffsetStabilityMs: 0.5,
        timingConfidence: expect.any(Number),
      }),
    );
    expect(result.event?.confidence).toBeGreaterThan(0.7);
    expect(result.event?.timingConfidence).toBeGreaterThan(0.7);
    expect(result.gate.open).toBe(true);
  });

  test("suppresses repeated events until the gate closes and spacing elapses", () => {
    const first = detectVoiceActivityEvent({
      gate: { open: false, lastEventHostEpochMs: null },
      micLevel: 0.08,
      frame: audioFrame({ hostEstimatedEpochMs: 10_000 }),
    });
    const held = detectVoiceActivityEvent({
      gate: first.gate,
      micLevel: 0.09,
      frame: audioFrame({ hostEstimatedEpochMs: 10_200, sampleIndex: 609_600 }),
    });
    const closed = detectVoiceActivityEvent({
      gate: held.gate,
      micLevel: 0.008,
      frame: audioFrame({ hostEstimatedEpochMs: 10_500, sampleIndex: 624_000 }),
    });
    const second = detectVoiceActivityEvent({
      gate: closed.gate,
      micLevel: 0.07,
      frame: audioFrame({ hostEstimatedEpochMs: 10_850, sampleIndex: 640_800 }),
    });

    expect(first.event).not.toBeNull();
    expect(held.event).toBeNull();
    expect(closed.event).toBeNull();
    expect(closed.gate.open).toBe(false);
    expect(second.event).not.toBeNull();
  });
});

function audioFrame(
  overrides: Partial<AudioFrameTimestamp> = {},
): AudioFrameTimestamp {
  return {
    audioContextTimeSeconds: 12.5,
    sampleIndex: 600_000,
    sampleRate: 48_000,
    clientPerfOriginEpochMs: 1_780_000_000_000,
    performanceNowMs: 100_000,
    clockOffsetMs: 0,
    clockUncertaintyMs: 4,
    clockQuality: 0.96,
    clockMaxErrorMs: 4,
    clockBestRoundTripMs: 8,
    clockJitterMs: 0.5,
    clockSamplesUsed: 8,
    clockOutliersRejected: 1,
    clockOffsetStabilityMs: 0.5,
    timingConfidence: 0.86,
    audioElapsedMs: 12_500,
    hostEstimatedEpochMs: 1_780_000_100_000,
    ...overrides,
  };
}
