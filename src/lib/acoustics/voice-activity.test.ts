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

  // Real phone captures sit at ~1e-4 RMS in a quiet room with speech peaking
  // around 1e-3 — far below the legacy absolute thresholds. The gate must
  // learn the device's floor and fire on a relative rise.
  test("adapts to a quiet real-phone capture floor", () => {
    let gate: VoiceActivityGate = { open: false, lastEventHostEpochMs: null };
    // Quiet room at iPhone raw-capture scale for the warm-up period.
    for (let index = 0; index < 40; index += 1) {
      const result = detectVoiceActivityEvent({
        gate,
        micLevel: 1e-4 + (index % 3) * 1e-5,
        frame: audioFrame({ hostEstimatedEpochMs: 30_000 + index * 16 }),
      });
      gate = result.gate;
      expect(result.event).toBeNull();
    }

    const speech = detectVoiceActivityEvent({
      gate,
      micLevel: 1.5e-3,
      frame: audioFrame({ hostEstimatedEpochMs: 31_000 }),
    });
    expect(speech.event).not.toBeNull();
    expect(speech.event!.confidence).toBeGreaterThan(0.5);
    expect(speech.gate.open).toBe(true);

    // Falling back to the floor closes the gate again.
    const quiet = detectVoiceActivityEvent({
      gate: speech.gate,
      micLevel: 1.1e-4,
      frame: audioFrame({ hostEstimatedEpochMs: 32_000 }),
    });
    expect(quiet.gate.open).toBe(false);
  });

  test("does not fire adaptively before the floor has warmed up", () => {
    let gate: VoiceActivityGate = { open: false, lastEventHostEpochMs: null };
    for (let index = 0; index < 5; index += 1) {
      const result = detectVoiceActivityEvent({
        gate,
        micLevel: 1e-4,
        frame: audioFrame({ hostEstimatedEpochMs: 40_000 + index * 16 }),
      });
      gate = result.gate;
    }
    const early = detectVoiceActivityEvent({
      gate,
      micLevel: 2e-3,
      frame: audioFrame({ hostEstimatedEpochMs: 40_200 }),
    });
    expect(early.event).toBeNull();
  });

  test("speech bursts do not drag the learned floor up under themselves", () => {
    let gate: VoiceActivityGate = { open: false, lastEventHostEpochMs: null };
    for (let index = 0; index < 40; index += 1) {
      gate = detectVoiceActivityEvent({
        gate,
        micLevel: 1e-4,
        frame: audioFrame({ hostEstimatedEpochMs: 50_000 + index * 16 }),
      }).gate;
    }
    // A long utterance holds the gate open...
    for (let index = 0; index < 120; index += 1) {
      gate = detectVoiceActivityEvent({
        gate,
        micLevel: 2e-3,
        frame: audioFrame({ hostEstimatedEpochMs: 51_000 + index * 16 }),
      }).gate;
    }
    expect(gate.open).toBe(true);
    // ...and after a pause the next utterance still fires.
    for (let index = 0; index < 30; index += 1) {
      gate = detectVoiceActivityEvent({
        gate,
        micLevel: 1.2e-4,
        frame: audioFrame({ hostEstimatedEpochMs: 53_000 + index * 16 }),
      }).gate;
    }
    const next = detectVoiceActivityEvent({
      gate,
      micLevel: 2e-3,
      frame: audioFrame({ hostEstimatedEpochMs: 54_000 }),
    });
    expect(next.event).not.toBeNull();
  });

  test("carries motion stability into voice event confidence", () => {
    const stable = detectVoiceActivityEvent({
      gate: { open: false, lastEventHostEpochMs: null },
      micLevel: 0.08,
      frame: audioFrame({ hostEstimatedEpochMs: 20_000 }),
      motionStability: 0.95,
    });
    const moving = detectVoiceActivityEvent({
      gate: { open: false, lastEventHostEpochMs: null },
      micLevel: 0.08,
      frame: audioFrame({ hostEstimatedEpochMs: 21_000 }),
      motionStability: 0.18,
    });

    expect(stable.event?.motionStability).toBe(0.95);
    expect(moving.event?.motionStability).toBe(0.18);
    expect(moving.event?.confidence).toBeLessThan(
      (stable.event?.confidence ?? 0) - 0.1,
    );
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
