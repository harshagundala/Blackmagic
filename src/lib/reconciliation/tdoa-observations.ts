// Turns one reconciled voice event into pairwise TDOA observations by
// GCC-PHAT-aligning each pair of raw-audio snippets directly.
//
// Timing lives in the SAMPLE DOMAIN, not the host clock. Each device's ADC
// sample counter is gapless, so `centerSampleIndex / sourceSampleRate` is an
// exact device-local timestamp of the snippet cut. Differencing those across
// devices plus the GCC content offset gives:
//
//   tdoaMs(A→B) = (center_B/fs_B − center_A/fs_A) · 1000 + gccOffsetMs
//               = (d_B − d_A)/c · 1000 + Δ_AB
//
// where Δ_AB is now the (large, arbitrary) difference of the two devices'
// capture-start instants plus their fixed input latencies. Crucially Δ_AB is
// CONSTANT to within the ADC sample-rate offset: unlike host-epoch mappings
// it carries no per-event clock-model jitter, which on real phones wobbles
// by several ms between events and is read by the spread estimator as
// phantom distance (a 2 ft pair once measured 6+ m through host-clock
// stamps). The host-epoch stamp is still attached for windowing/clustering,
// but never enters the TDOA value.
//
// For events heard by three or more devices the pairwise delays must close
// every triangle (τ_AB + τ_BC = τ_AC holds exactly for true arrivals, since
// the per-device nuisance offsets telescope); the closure residual demotes
// or removes matches that locked onto a reflection.

import { estimateRawAudioOffset } from "../acoustics/audio-snippet";
import type {
  ReconciledAudioEvent,
  ReconciledAudioEventObservation,
} from "../session/audio-events";
import { pairKeyFor, type PairTdoaObservation } from "./pair-tdoa-history";

export type PairTdoaQualityOptions = {
  minCorrelation?: number;
  minPhatPeak?: number;
  minPeakRatio?: number;
  maxLagMs?: number;
  maxClosureResidualMs?: number;
};

const MIN_CORRELATION = 0.42;
const MIN_PHAT_PEAK = 0.05;
const MIN_PEAK_RATIO = 1.1;
// VAD trigger times on two devices differ by arrival spread plus detection
// jitter; the event clusterer admits up to ~80 ms of spread, and 240 ms
// windows still overlap enough at this lag to correlate.
const MAX_LAG_MS = 48;
const MAX_CLOSURE_RESIDUAL_MS = 1.5;

export function derivePairTdoaObservations(
  event: ReconciledAudioEvent,
  {
    minCorrelation = MIN_CORRELATION,
    minPhatPeak = MIN_PHAT_PEAK,
    minPeakRatio = MIN_PEAK_RATIO,
    maxLagMs = MAX_LAG_MS,
    maxClosureResidualMs = MAX_CLOSURE_RESIDUAL_MS,
  }: PairTdoaQualityOptions = {},
): PairTdoaObservation[] {
  const eligible = dedupeByDevice(
    event.observations.filter((observation) => observation.audioSnippet),
  ).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  if (eligible.length < 2) {
    return [];
  }

  const pairs: PairTdoaObservation[] = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      const from = eligible[i];
      const to = eligible[j];
      const offset = estimateRawAudioOffset(from.audioSnippet, to.audioSnippet, {
        maxLagMs,
      });
      if (
        !offset ||
        offset.correlation < minCorrelation ||
        offset.phatPeak < minPhatPeak ||
        offset.peakRatio < minPeakRatio
      ) {
        continue;
      }

      const fromSampleMs = sampleDomainMs(from);
      const toSampleMs = sampleDomainMs(to);
      if (fromSampleMs === null || toSampleMs === null) {
        continue;
      }
      const tdoaMs = toSampleMs - fromSampleMs + offset.offsetMs;
      pairs.push({
        pairKey: pairKeyFor(from.deviceId, to.deviceId),
        from: from.deviceId,
        to: to.deviceId,
        tdoaMs: round(tdoaMs, 3),
        weight: observationWeight(offset.correlation, offset.phatPeak, from, to),
        atHostEpochMs: Math.max(
          from.detectedAtHostEpochMs,
          to.detectedAtHostEpochMs,
        ),
        eventId: event.id,
      });
    }
  }

  return applyTriangleClosure(pairs, maxClosureResidualMs);
}

// Device-local snippet-cut time from the gapless ADC sample counter.
function sampleDomainMs(observation: ReconciledAudioEventObservation) {
  const snippet = observation.audioSnippet;
  if (
    !snippet ||
    !Number.isFinite(snippet.centerSampleIndex) ||
    !Number.isFinite(snippet.sourceSampleRate) ||
    snippet.sourceSampleRate <= 0
  ) {
    return null;
  }
  return (snippet.centerSampleIndex / snippet.sourceSampleRate) * 1_000;
}

function dedupeByDevice(observations: ReconciledAudioEventObservation[]) {
  const byDevice = new Map<string, ReconciledAudioEventObservation>();
  for (const observation of observations) {
    const existing = byDevice.get(observation.deviceId);
    if (!existing || observation.confidence > existing.confidence) {
      byDevice.set(observation.deviceId, observation);
    }
  }
  return [...byDevice.values()];
}

function observationWeight(
  correlation: number,
  phatPeak: number,
  from: ReconciledAudioEventObservation,
  to: ReconciledAudioEventObservation,
) {
  const alignmentScore =
    clamp01(correlation) * (0.5 + 0.5 * Math.min(1, phatPeak / 0.2));
  const eventScore = clamp01(
    Math.min(from.confidence, to.confidence) * 0.5 + 0.5,
  );
  return round(Math.max(0.05, alignmentScore * eventScore), 3);
}

// Every triangle of true arrival differences telescopes to zero. A residual
// means at least one of the three alignments is wrong (usually a reflection
// lock), so demote all three; with several devices the bad edge gets
// demoted in every triangle it touches while good edges recover elsewhere.
function applyTriangleClosure(
  pairs: PairTdoaObservation[],
  maxResidualMs: number,
) {
  if (pairs.length < 3) {
    return pairs;
  }

  const byKey = new Map(pairs.map((pair) => [pair.pairKey, pair]));
  const deviceIds = [
    ...new Set(pairs.flatMap((pair) => [pair.from, pair.to])),
  ].sort();
  const penalties = new Map<string, number>();

  for (let i = 0; i < deviceIds.length; i += 1) {
    for (let j = i + 1; j < deviceIds.length; j += 1) {
      for (let k = j + 1; k < deviceIds.length; k += 1) {
        const ab = byKey.get(pairKeyFor(deviceIds[i], deviceIds[j]));
        const bc = byKey.get(pairKeyFor(deviceIds[j], deviceIds[k]));
        const ac = byKey.get(pairKeyFor(deviceIds[i], deviceIds[k]));
        if (!ab || !bc || !ac) {
          continue;
        }
        const residual = Math.abs(ab.tdoaMs + bc.tdoaMs - ac.tdoaMs);
        if (residual <= maxResidualMs) {
          continue;
        }
        const penalty = 1 / (1 + (residual / maxResidualMs) ** 2);
        for (const pair of [ab, bc, ac]) {
          penalties.set(
            pair.pairKey,
            Math.min(penalties.get(pair.pairKey) ?? 1, penalty),
          );
        }
      }
    }
  }

  if (penalties.size === 0) {
    return pairs;
  }
  return pairs
    .map((pair) => ({
      ...pair,
      weight: round(pair.weight * (penalties.get(pair.pairKey) ?? 1), 3),
    }))
    .filter((pair) => pair.weight >= 0.05);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, decimals: number) {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Number(value.toFixed(decimals));
}
