import { describe, expect, test } from "vitest";
import {
  createEdgeEvidence,
  deriveEdgeRanges,
  mergeAcousticRanges,
  recordEdgeObservation,
  recordEdgePulse,
} from "./edge-reconciliation";
import type { AcousticRange } from "../session/ranging";

const SAMPLE_RATE = 48_000;

describe("edge reconciliation", () => {
  test("derives a pairwise range from locally collected reciprocal chirps", () => {
    const evidence = createEdgeEvidence();
    const pulseA = {
      id: "device-a:1:1000",
      emittedAtHostEpochMs: 1_000,
      durationMs: 48,
      frequencyHz: 17_200,
      endFrequencyHz: 19_200,
    };
    const pulseB = {
      id: "device-b:2:2010",
      emittedAtHostEpochMs: 2_010,
      durationMs: 48,
      frequencyHz: 17_200,
      endFrequencyHz: 19_200,
    };

    expect(recordEdgePulse(evidence, "device-a", pulseA)).toBe(true);
    expect(recordEdgePulse(evidence, "device-b", pulseB)).toBe(true);
    // Re-recording the same pulse reports no new evidence.
    expect(recordEdgePulse(evidence, "device-a", pulseA)).toBe(false);

    // True distance 3.43 m -> 10 ms propagation -> 480 samples at 48 kHz.
    // A's interval (self chirp -> B's chirp) exceeds B's interval (A's chirp
    // -> self chirp) by exactly twice the propagation: 960 samples.
    recordEdgeObservation(evidence, "device-a", {
      pulseId: pulseA.id,
      detectedAtHostEpochMs: 1_000,
      detectedSampleIndex: 10_000,
      sampleRate: SAMPLE_RATE,
      amplitude: 0.4,
      confidence: 0.9,
    });
    recordEdgeObservation(evidence, "device-a", {
      pulseId: pulseB.id,
      detectedAtHostEpochMs: 2_020,
      detectedSampleIndex: 58_480,
      sampleRate: SAMPLE_RATE,
      amplitude: 0.35,
      confidence: 0.85,
    });
    recordEdgeObservation(evidence, "device-b", {
      pulseId: pulseA.id,
      detectedAtHostEpochMs: 1_010,
      detectedSampleIndex: 20_480,
      sampleRate: SAMPLE_RATE,
      amplitude: 0.32,
      confidence: 0.88,
    });
    recordEdgeObservation(evidence, "device-b", {
      pulseId: pulseB.id,
      detectedAtHostEpochMs: 2_010,
      detectedSampleIndex: 68_000,
      sampleRate: SAMPLE_RATE,
      amplitude: 0.42,
      confidence: 0.92,
    });

    const ranges = deriveEdgeRanges(evidence);

    expect(ranges).toHaveLength(1);
    expect(ranges[0].meters).toBeCloseTo(3.43, 2);
    expect([ranges[0].from, ranges[0].to].sort()).toEqual([
      "device-a",
      "device-b",
    ]);
    expect(ranges[0].confidence).toBeGreaterThan(0.5);
  });

  test("needs evidence from at least two devices", () => {
    const evidence = createEdgeEvidence();
    recordEdgePulse(evidence, "device-a", {
      id: "device-a:1:1000",
      emittedAtHostEpochMs: 1_000,
      durationMs: 48,
      frequencyHz: 17_200,
    });

    expect(deriveEdgeRanges(evidence)).toEqual([]);
  });

  test("merge keeps the fresher measurement per pair and edge wins ties", () => {
    const serverRange: AcousticRange = makeRange("a", "b", 2.4, 5_000);
    const staleEdge: AcousticRange = makeRange("b", "a", 9.9, 4_000);
    const freshEdge: AcousticRange = makeRange("a", "c", 1.2, 6_000);
    const tieEdge: AcousticRange = makeRange("a", "b", 2.6, 5_000);

    const merged = mergeAcousticRanges([serverRange], [staleEdge, freshEdge]);
    expect(merged).toHaveLength(2);
    expect(merged.find((range) => pair(range) === "a:b")?.meters).toBe(2.4);
    expect(merged.find((range) => pair(range) === "a:c")?.meters).toBe(1.2);

    const tied = mergeAcousticRanges([serverRange], [tieEdge]);
    expect(tied.find((range) => pair(range) === "a:b")?.meters).toBe(2.6);
  });
});

function pair(range: AcousticRange) {
  return [range.from, range.to].sort().join(":");
}

function makeRange(
  from: string,
  to: string,
  meters: number,
  observedAtHostEpochMs: number,
): AcousticRange {
  return {
    from,
    to,
    pulseId: `${from}:${observedAtHostEpochMs}`,
    pulseIds: [`${from}:${observedAtHostEpochMs}`],
    samplesUsed: 1,
    meters,
    timingUncertaintyMs: 0.1,
    distanceUncertaintyMeters: 0.03,
    confidence: 0.8,
    observedAtHostEpochMs,
  };
}
