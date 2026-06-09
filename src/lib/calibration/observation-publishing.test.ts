import { describe, expect, test } from "vitest";
import {
  acousticObservationPublishKey,
  shouldPublishAcousticObservation,
} from "./observation-publishing";
import type { AcousticObservation } from "@/lib/session/registry";

describe("acoustic observation publishing", () => {
  test("publishes a stronger sample-anchored replacement for the same pulse", () => {
    const first = observation({
      pulseId: "pulse-a",
      detectedSampleIndex: 640,
      amplitude: 0.18,
      confidence: 0.42,
    });
    const stronger = observation({
      pulseId: "pulse-a",
      detectedSampleIndex: 1_260,
      amplitude: 0.72,
      confidence: 0.86,
    });

    expect(shouldPublishAcousticObservation(first, stronger)).toBe(true);
  });

  test("does not republish equivalent same-pulse observations", () => {
    const first = observation({
      pulseId: "pulse-a",
      detectedSampleIndex: 640,
      amplitude: 0.72,
      confidence: 0.86,
    });
    const duplicate = observation({
      pulseId: "pulse-a",
      detectedSampleIndex: 640,
      amplitude: 0.73,
      confidence: 0.86,
    });

    expect(shouldPublishAcousticObservation(first, duplicate)).toBe(false);
  });

  test("publishes the first observation and new pulse ids", () => {
    const first = observation({ pulseId: "pulse-a" });
    const nextPulse = observation({ pulseId: "pulse-b" });

    expect(shouldPublishAcousticObservation(null, first)).toBe(true);
    expect(shouldPublishAcousticObservation(first, nextPulse)).toBe(true);
  });

  test("keys sample-anchored replacements by pulse and detected sample", () => {
    expect(
      acousticObservationPublishKey(
        observation({
          pulseId: "pulse-a",
          detectedSampleIndex: 640,
          sampleRate: 48_000,
        }),
      ),
    ).toBe("pulse-a:48000:640");
    expect(
      acousticObservationPublishKey(
        observation({
          pulseId: "pulse-a",
          detectedSampleIndex: undefined,
          sampleRate: undefined,
        }),
      ),
    ).toBe("pulse-a:timestamp");
  });
});

function observation(
  overrides: Partial<AcousticObservation> = {},
): AcousticObservation {
  return {
    pulseId: "pulse",
    detectedAtHostEpochMs: 10_000,
    detectedSampleIndex: 640,
    sampleRate: 48_000,
    amplitude: 0.5,
    confidence: 0.6,
    clockUncertaintyMs: 2,
    ...overrides,
  };
}
