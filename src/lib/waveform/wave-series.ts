// A per-device time series of microphone envelope levels on the shared
// host-clock timeline. Local capture appends single samples; remote devices
// arrive as fixed-cadence chunks over the data channel. Rendering resamples a
// trailing window so every phone's waveform is drawn against the same clock —
// which makes sync quality directly visible (a clap aligns across rows).

export type WaveChunk = {
  endHostEpochMs: number;
  bucketMs: number;
  levels: number[];
};

type WaveSample = {
  tMs: number;
  level: number;
};

// A device's host-epoch estimate can jump when its clock source switches
// (HTTP server prior -> data-channel host sync). A backward jump bigger than
// this is a timeline rebase: keep stale samples and every new sample would be
// "non-increasing" and silently dropped until wall time caught up — a dead
// waveform for seconds. Restart the series instead.
const TIMELINE_REBASE_MS = 1_500;

export class WaveSeries {
  private samples: WaveSample[] = [];

  constructor(private readonly capacityMs = 8_000) {}

  appendSample(tMs: number, level: number) {
    if (!Number.isFinite(tMs) || !Number.isFinite(level)) {
      return;
    }

    const last = this.samples[this.samples.length - 1];
    if (last && tMs <= last.tMs) {
      if (last.tMs - tMs > TIMELINE_REBASE_MS) {
        this.samples = [];
      } else {
        return;
      }
    }
    this.samples.push({ tMs, level: Math.max(0, level) });
    this.trim(tMs);
  }

  appendChunk(chunk: WaveChunk) {
    const { endHostEpochMs, bucketMs, levels } = chunk;
    if (
      !Number.isFinite(endHostEpochMs) ||
      !Number.isFinite(bucketMs) ||
      bucketMs <= 0 ||
      levels.length === 0
    ) {
      return;
    }

    // appendSample rejects non-increasing timestamps, which silently drops
    // the overlap between consecutive chunks.
    for (let index = 0; index < levels.length; index += 1) {
      const tMs = endHostEpochMs - (levels.length - 1 - index) * bucketMs;
      this.appendSample(tMs, levels[index]);
    }
  }

  latestMs(): number | null {
    return this.samples.length > 0
      ? this.samples[this.samples.length - 1].tMs
      : null;
  }

  // Resamples the [endMs - durationMs, endMs] window into `buckets` peak
  // levels for rendering. Gaps stay at zero, so transport stalls are visible
  // as flat-lined sections instead of being interpolated away.
  window(endMs: number, durationMs: number, buckets: number): Float32Array {
    const out = new Float32Array(buckets);
    if (
      !Number.isFinite(endMs) ||
      durationMs <= 0 ||
      buckets <= 0 ||
      this.samples.length === 0
    ) {
      return out;
    }

    const startMs = endMs - durationMs;
    const bucketMs = durationMs / buckets;
    for (const sample of this.samples) {
      if (sample.tMs < startMs || sample.tMs > endMs) {
        continue;
      }
      const bucket = Math.min(
        buckets - 1,
        Math.floor((sample.tMs - startMs) / bucketMs),
      );
      out[bucket] = Math.max(out[bucket], sample.level);
    }
    return out;
  }

  // Recent peak used for display auto-gain.
  recentPeak(endMs: number, durationMs: number): number {
    let peak = 0;
    const startMs = endMs - durationMs;
    for (const sample of this.samples) {
      if (sample.tMs >= startMs && sample.tMs <= endMs) {
        peak = Math.max(peak, sample.level);
      }
    }
    return peak;
  }

  private trim(nowMs: number) {
    const cutoff = nowMs - this.capacityMs;
    let firstKept = 0;
    while (
      firstKept < this.samples.length &&
      this.samples[firstKept].tMs < cutoff
    ) {
      firstKept += 1;
    }
    if (firstKept > 0) {
      this.samples.splice(0, firstKept);
    }
  }
}

// Builds the outgoing chunk for a sensor frame: the trailing `levels.length`
// fixed-cadence buckets ending at the newest local sample.
export function buildWaveChunk(
  series: WaveSeries,
  bucketMs: number,
  bucketCount: number,
): WaveChunk | null {
  const endMs = series.latestMs();
  if (endMs === null || bucketMs <= 0 || bucketCount <= 0) {
    return null;
  }

  const window = series.window(endMs, bucketMs * bucketCount, bucketCount);
  return {
    endHostEpochMs: Math.round(endMs),
    bucketMs,
    levels: [...window].map((level) => Number(level.toFixed(4))),
  };
}
