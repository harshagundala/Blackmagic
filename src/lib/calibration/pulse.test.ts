import { describe, expect, test } from "vitest";
import {
  createMatchedToneObservation,
  createScheduledAcousticPulse,
  createToneObservation,
} from "./pulse";
import { synthesizePulseTemplate } from "../acoustics/pulse-detector";

describe("active acoustic pulse metadata", () => {
  test("schedules a future host-aligned pulse with a stable id", () => {
    expect(
      createScheduledAcousticPulse({
        deviceId: "host-a",
        sequence: 7,
        hostEpochNowMs: 20_000,
        leadMs: 2_200,
        audioFrame: {
          sampleIndex: 480_000,
          sampleRate: 48_000,
          hostEstimatedEpochMs: 20_000,
        },
      }),
    ).toEqual({
      id: "host-a:7:22200",
      emittedAtHostEpochMs: 22_200,
      durationMs: 48,
      frequencyHz: 17_200,
      endFrequencyHz: 19_200,
      emittedSampleIndex: 585_600,
      sampleRate: 48_000,
    });
  });

  test("creates observations only inside the same-room propagation window", () => {
    const pulse = createScheduledAcousticPulse({
      deviceId: "host-a",
      sequence: 1,
      hostEpochNowMs: 20_000,
      leadMs: 0,
    });

    expect(
      createToneObservation({
        pulse,
        detectedAtHostEpochMs: 20_006,
        micLevel: 0.08,
        clockUncertaintyMs: 2,
      }),
    ).toEqual({
      pulseId: "host-a:1:20000",
      detectedAtHostEpochMs: 20_006,
      amplitude: 0.08,
      confidence: 0.6,
      clockUncertaintyMs: 2,
    });
    expect(
      createToneObservation({
        pulse,
        detectedAtHostEpochMs: 20_090,
        micLevel: 0.08,
        clockUncertaintyMs: 2,
      }),
    ).toBeNull();
    expect(
      createToneObservation({
        pulse,
        detectedAtHostEpochMs: 20_006,
        micLevel: 0.004,
        clockUncertaintyMs: 2,
      }),
    ).toBeNull();
  });

  test("creates a sample-anchored observation from a matched historical audio sample", () => {
    const pulse = createScheduledAcousticPulse({
      deviceId: "host-a",
      sequence: 2,
      hostEpochNowMs: 20_000,
      leadMs: 0,
      durationMs: 12,
      frequencyHz: 2_000,
      endFrequencyHz: 3_200,
    });
    const sampleRate = 48_000;
    const template = synthesizePulseTemplate({
      frequencyHz: pulse.frequencyHz,
      endFrequencyHz: pulse.endFrequencyHz,
      durationMs: pulse.durationMs,
      sampleRate,
    });
    const samples = new Float32Array(2_048);
    const startSampleIndex = 480_000;
    const detectedOffsetSamples = 288;
    for (let index = 0; index < template.length; index += 1) {
      samples[detectedOffsetSamples + index] = template[index] * 0.7;
    }

    const observation = createMatchedToneObservation({
      pulse,
      audioWindow: {
        samples,
        sampleRate,
        startSampleIndex,
        anchorAudioContextTimeSeconds:
          (startSampleIndex + samples.length) / sampleRate,
        anchorPerformanceNowMs:
          ((startSampleIndex + samples.length) / sampleRate) * 1_000,
        clientPerfOriginEpochMs: 0,
        clockOffsetMs: 0,
        clockUncertaintyMs: 2,
      },
      minScore: 0.42,
      minPeakRatio: 3,
    });

    expect(observation).toEqual(
      expect.objectContaining({
        pulseId: "host-a:2:20000",
        detectedAtHostEpochMs: 10_006,
        detectedSampleIndex: 480_288,
        sampleRate,
        confidence: expect.any(Number),
      }),
    );
    expect(observation?.confidence).toBeGreaterThan(0.5);
  });
});
