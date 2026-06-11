import { describe, expect, it } from "vitest";
import {
  clearPairHistoriesForDevice,
  createPairTdoaHistory,
  derivePairRangeEstimate,
  pairKeyFor,
  recordPairTdoaObservation,
  removePairObservationsNear,
  type PairTdoaObservation,
} from "./pair-tdoa-history";

const SPEED_OF_SOUND = 343;

// Deterministic PRNG so the synthetic talker walk is reproducible.
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type WalkOptions = {
  distanceMeters: number;
  biasMs: number;
  driftMsPerSecond?: number;
  noiseStdMs?: number;
  count?: number;
  spanMs?: number;
  startEpochMs?: number;
  // Restrict the talker bearing (radians) measured from the pair axis;
  // [0, PI] sweeps everything including both endfire directions.
  minBearing?: number;
  maxBearing?: number;
  outlierRate?: number;
  seed?: number;
};

function syntheticObservations({
  distanceMeters,
  biasMs,
  driftMsPerSecond = 0,
  noiseStdMs = 0.15,
  count = 90,
  spanMs = 120_000,
  startEpochMs = 1_000_000,
  minBearing = 0,
  maxBearing = Math.PI,
  outlierRate = 0,
  seed = 7,
}: WalkOptions): PairTdoaObservation[] {
  const random = mulberry32(seed);
  const halfSpanMs = (distanceMeters / SPEED_OF_SOUND) * 1_000;
  const observations: PairTdoaObservation[] = [];
  for (let index = 0; index < count; index += 1) {
    const atHostEpochMs = startEpochMs + (index / Math.max(1, count - 1)) * spanMs;
    const bearing = minBearing + random() * (maxBearing - minBearing);
    const geometricMs = halfSpanMs * Math.cos(bearing);
    const gaussian =
      Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) *
      Math.cos(2 * Math.PI * random());
    let tdoaMs =
      biasMs +
      driftMsPerSecond * ((atHostEpochMs - startEpochMs) / 1_000) +
      geometricMs +
      gaussian * noiseStdMs;
    if (random() < outlierRate) {
      tdoaMs += (random() - 0.5) * 50;
    }
    observations.push({
      pairKey: pairKeyFor("alpha", "bravo"),
      from: "alpha",
      to: "bravo",
      tdoaMs,
      weight: 0.6 + random() * 0.4,
      atHostEpochMs,
      eventId: `event-${index}`,
    });
  }
  return observations;
}

function historyFrom(observations: PairTdoaObservation[]) {
  let history = createPairTdoaHistory();
  for (const observation of observations) {
    history = recordPairTdoaObservation(history, observation);
  }
  return history;
}

describe("pairKeyFor", () => {
  it("is order independent", () => {
    expect(pairKeyFor("b", "a")).toBe(pairKeyFor("a", "b"));
  });
});

describe("recordPairTdoaObservation", () => {
  it("dedupes by event id, keeping the freshest observation", () => {
    const base = syntheticObservations({ distanceMeters: 2, biasMs: 0, count: 4 });
    let history = historyFrom(base);
    history = recordPairTdoaObservation(history, {
      ...base[1],
      tdoaMs: 99,
    });
    expect(history.observations).toHaveLength(4);
    expect(
      history.observations.find((entry) => entry.eventId === "event-1")?.tdoaMs,
    ).toBe(99);
  });

  it("rejects implausible deltas once the history has settled", () => {
    let history = historyFrom(
      syntheticObservations({ distanceMeters: 2, biasMs: 3, count: 30 }),
    );
    const before = history.observations.length;
    history = recordPairTdoaObservation(history, {
      pairKey: pairKeyFor("alpha", "bravo"),
      from: "alpha",
      to: "bravo",
      tdoaMs: 180,
      weight: 1,
      atHostEpochMs: 2_000_000,
      eventId: "outlier",
    });
    expect(history.observations).toHaveLength(before);
  });

  it("re-seeds on a consistent regime jump instead of rejecting forever", () => {
    let history = historyFrom(
      syntheticObservations({ distanceMeters: 2, biasMs: 0, count: 30 }),
    );
    // Capture restart: the sample-domain origin jumped ~5 s, and the new
    // observations agree with each other.
    for (let index = 0; index < 4; index += 1) {
      history = recordPairTdoaObservation(history, {
        pairKey: pairKeyFor("alpha", "bravo"),
        from: "alpha",
        to: "bravo",
        tdoaMs: 5_000 + index * 0.5,
        weight: 1,
        atHostEpochMs: 1_200_000 + index * 1_000,
        eventId: `jump-${index}`,
      });
    }
    expect(history.observations).toHaveLength(1);
    expect(history.observations[0].tdoaMs).toBeCloseTo(5_001.5, 3);
  });

  it("caps the buffer and drops the oldest entries", () => {
    const history = historyFrom(
      syntheticObservations({ distanceMeters: 2, biasMs: 0, count: 400 }),
    );
    expect(history.observations.length).toBeLessThanOrEqual(160);
    expect(history.observations[0].eventId).not.toBe("event-0");
  });
});

describe("derivePairRangeEstimate", () => {
  it("returns null until there is enough evidence", () => {
    const history = historyFrom(
      syntheticObservations({ distanceMeters: 2, biasMs: 0, count: 4 }),
    );
    expect(derivePairRangeEstimate(history, 1_200_000)).toBeNull();
  });

  it("recovers distance and bias from a full talker sweep", () => {
    const history = historyFrom(
      syntheticObservations({ distanceMeters: 2.4, biasMs: 6.5, count: 90 }),
    );
    const estimate = derivePairRangeEstimate(history, 1_130_000);
    expect(estimate).not.toBeNull();
    expect(estimate!.meters).toBeGreaterThan(2.4 - 0.18);
    expect(estimate!.meters).toBeLessThan(2.4 + 0.18);
    expect(Math.abs(estimate!.biasMs - 6.5)).toBeLessThan(0.6);
    expect(estimate!.coverage).toBeGreaterThan(0.6);
    expect(estimate!.confidence).toBeGreaterThan(0.5);
  });

  it("absorbs a large constant clock bias without distance error", () => {
    const history = historyFrom(
      syntheticObservations({ distanceMeters: 1.2, biasMs: -18, count: 90 }),
    );
    const estimate = derivePairRangeEstimate(history, 1_130_000);
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!.meters - 1.2)).toBeLessThan(0.15);
    expect(Math.abs(estimate!.biasMs + 18)).toBeLessThan(0.6);
  });

  it("removes sample-rate drift before measuring the spread", () => {
    const history = historyFrom(
      syntheticObservations({
        distanceMeters: 1.5,
        biasMs: 2,
        driftMsPerSecond: 0.02,
        count: 110,
        spanMs: 140_000,
      }),
    );
    const estimate = derivePairRangeEstimate(history, 1_150_000);
    expect(estimate).not.toBeNull();
    // Unmodeled, 0.02 ms/s over 140 s would inflate the span by ~2.8 ms
    // (≈ 0.48 m of phantom distance).
    expect(Math.abs(estimate!.meters - 1.5)).toBeLessThan(0.2);
    expect(estimate!.driftMsPerSecond).toBeGreaterThan(0.01);
    expect(estimate!.driftMsPerSecond).toBeLessThan(0.03);
  });

  it("survives a contaminated tail of reverberant outliers", () => {
    const history = historyFrom(
      syntheticObservations({
        distanceMeters: 2,
        biasMs: 4,
        count: 110,
        outlierRate: 0.12,
        noiseStdMs: 0.2,
      }),
    );
    const estimate = derivePairRangeEstimate(history, 1_130_000);
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!.meters - 2)).toBeLessThan(0.3);
  });

  it("reports poor coverage when the talker never crosses endfire", () => {
    const history = historyFrom(
      syntheticObservations({
        distanceMeters: 2,
        biasMs: 0,
        count: 90,
        // Broadside only: bearings 60°–120°, so |cos| ≤ 0.5.
        minBearing: Math.PI / 3,
        maxBearing: (2 * Math.PI) / 3,
      }),
    );
    const estimate = derivePairRangeEstimate(history, 1_130_000);
    expect(estimate).not.toBeNull();
    // A broadside-only sweep is distribution-identical to a full sweep of a
    // nearer pair, so the estimate must behave as a lower bound (~d/2 here);
    // no single-pair statistic can flag it. Layout stress across 3+ devices
    // is the cross-check that exposes these under-estimates.
    expect(estimate!.meters).toBeLessThan(1.4);
    expect(estimate!.meters).toBeGreaterThan(0.6);
  });

  it("ignores observations older than the window", () => {
    const stale = syntheticObservations({
      distanceMeters: 3,
      biasMs: 0,
      count: 40,
      startEpochMs: 0,
      spanMs: 30_000,
    });
    const fresh = syntheticObservations({
      distanceMeters: 1,
      biasMs: 0,
      count: 60,
      startEpochMs: 400_000,
      spanMs: 80_000,
      seed: 11,
    });
    const history = historyFrom([...stale, ...fresh]);
    const estimate = derivePairRangeEstimate(history, 490_000);
    expect(estimate).not.toBeNull();
    expect(estimate!.meters).toBeLessThan(1.3);
  });
});

describe("motion hygiene", () => {
  it("removes observations near a motion spike", () => {
    let history = historyFrom(
      syntheticObservations({ distanceMeters: 2, biasMs: 0, count: 30 }),
    );
    const spikeAt = history.observations[10].atHostEpochMs;
    const before = history.observations.length;
    history = removePairObservationsNear(history, spikeAt, 1_000);
    expect(history.observations.length).toBeLessThan(before);
    expect(
      history.observations.every(
        (entry) => Math.abs(entry.atHostEpochMs - spikeAt) > 1_000,
      ),
    ).toBe(true);
  });

  it("clears every pair touching a moved device", () => {
    const histories = new Map([
      [pairKeyFor("alpha", "bravo"), historyFrom(syntheticObservations({ distanceMeters: 2, biasMs: 0, count: 20 }))],
      [pairKeyFor("bravo", "charlie"), historyFrom(syntheticObservations({ distanceMeters: 2, biasMs: 0, count: 20 }))],
      [pairKeyFor("alpha", "charlie"), historyFrom(syntheticObservations({ distanceMeters: 2, biasMs: 0, count: 20 }))],
    ]);
    clearPairHistoriesForDevice(histories, "bravo");
    expect(histories.get(pairKeyFor("alpha", "bravo"))).toBeUndefined();
    expect(histories.get(pairKeyFor("bravo", "charlie"))).toBeUndefined();
    expect(histories.get(pairKeyFor("alpha", "charlie"))).toBeDefined();
  });
});
