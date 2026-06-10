import { describe, expect, test } from "vitest";
import { buildWaveChunk, WaveSeries } from "./wave-series";

describe("wave series", () => {
  test("appends samples in time order and ignores regressions", () => {
    const series = new WaveSeries();
    series.appendSample(1_000, 0.2);
    series.appendSample(1_020, 0.4);
    series.appendSample(1_010, 0.9);

    expect(series.latestMs()).toBe(1_020);
    const window = series.window(1_030, 40, 2);
    expect(window[0]).toBeCloseTo(0.2, 5);
    expect(window[1]).toBeCloseTo(0.4, 5);
  });

  test("overlapping chunks merge without duplicating samples", () => {
    const series = new WaveSeries();
    series.appendChunk({
      endHostEpochMs: 1_100,
      bucketMs: 20,
      levels: [0.1, 0.2, 0.3],
    });
    // Re-sends the 1_100 bucket and adds two new ones.
    series.appendChunk({
      endHostEpochMs: 1_140,
      bucketMs: 20,
      levels: [0.35, 0.4, 0.5],
    });

    expect(series.latestMs()).toBe(1_140);
    const window = series.window(1_150, 120, 6);
    expect([...window].map((v) => Number(v.toFixed(2)))).toEqual([
      0, 0.1, 0.2, 0.3, 0.4, 0.5,
    ]);
  });

  test("transport gaps render as silence instead of interpolation", () => {
    const series = new WaveSeries();
    series.appendSample(1_000, 0.8);
    series.appendSample(3_000, 0.6);

    const window = series.window(3_000, 2_000, 4);
    expect(window[0]).toBeCloseTo(0.8, 5);
    expect(window[1]).toBe(0);
    expect(window[2]).toBe(0);
    expect(window[3]).toBeCloseTo(0.6, 5);
  });

  test("trims history beyond capacity", () => {
    const series = new WaveSeries(1_000);
    series.appendSample(0, 0.9);
    series.appendSample(2_000, 0.1);

    expect(series.recentPeak(2_000, 10_000)).toBeCloseTo(0.1, 5);
  });

  test("builds fixed-cadence outgoing chunks from the trailing window", () => {
    const series = new WaveSeries();
    for (let index = 0; index < 20; index += 1) {
      series.appendSample(1_000 + index * 10, index / 20);
    }

    const chunk = buildWaveChunk(series, 20, 5);
    expect(chunk).not.toBeNull();
    expect(chunk?.endHostEpochMs).toBe(1_190);
    expect(chunk?.levels).toHaveLength(5);
    expect(chunk?.levels[4]).toBeGreaterThan(chunk!.levels[0]);
    expect(buildWaveChunk(new WaveSeries(), 20, 5)).toBeNull();
  });
});
