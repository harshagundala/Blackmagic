import {
  createMatchedToneObservation,
  type AudioPulseWindow,
} from "./pulse";
import type { AcousticObservation, AcousticPulse } from "@/lib/session/registry";

// Scheduled audio leaves an iPhone speaker well AFTER its scheduled instant —
// output latency measured at 130-230 ms on ground-truth takes, and a peer's
// emission adds its own. The search window, the "arrived" gate, and the
// chirp/voice suppression window all budget this with headroom. Underbudgeting
// it (the prior ~180 ms allowance) silently missed most chirps, including a
// phone's own — which the UI then reported as "can't hear own chirps".
export const CHIRP_OUTPUT_LATENCY_ALLOWANCE_MS = 450;

// Field-calibrated against ground-truth recordings: real phone-to-phone chirp
// receptions score 0.05-0.5 with correlation peak ratios of 6-50, while
// chirp-free audio (speech included) stays below ~0.01 score and ~6 ratio.
const CHIRP_MIN_SCORE = 0.05;
const CHIRP_MIN_PEAK_RATIO = 4;

export type ScheduledPulseFrame = {
  sampleIndex: number;
  hostEstimatedEpochMs: number;
  sampleRate: number;
  clockUncertaintyMs: number;
};

// Re-search a captured audio window for a scheduled chirp with the bounded
// matched-filter fallback. Two stages keep it main-thread-cheap: a high-passed
// energy pre-scan finds the burst, then the matched filter refines ±25 ms
// around it. The pre-scan runs on the signal's second difference (a crude
// high-pass, ~60 dB of relative gain at the chirp band over speech) because an
// ultrasonic chirp does NOT dominate broadband energy — a talker would
// otherwise capture the energy peak and the refinement would search the wrong
// spot.
export function detectScheduledPulse({
  pulse,
  frame,
  audioWindow,
  clockUncertaintyMs,
}: {
  pulse: AcousticPulse;
  frame: ScheduledPulseFrame;
  audioWindow: AudioPulseWindow;
  clockUncertaintyMs?: number;
}): AcousticObservation | null {
  const sampleRate = audioWindow.sampleRate;
  const uncertaintyMs = clockUncertaintyMs ?? frame.clockUncertaintyMs;
  const earlyMs = Math.max(80, uncertaintyMs * 2);
  const lateMs = Math.max(CHIRP_OUTPUT_LATENCY_ALLOWANCE_MS, uncertaintyMs * 3);

  const expectedStartSampleIndex =
    frame.sampleIndex +
    ((pulse.emittedAtHostEpochMs - frame.hostEstimatedEpochMs) / 1_000) *
      frame.sampleRate;
  const searchStartSample = Math.max(
    0,
    Math.floor(
      expectedStartSampleIndex -
        audioWindow.startSampleIndex -
        (earlyMs / 1_000) * sampleRate,
    ),
  );
  const searchEndSample = Math.min(
    audioWindow.samples.length,
    Math.ceil(
      expectedStartSampleIndex -
        audioWindow.startSampleIndex +
        ((lateMs + pulse.durationMs) / 1_000) * sampleRate,
    ),
  );
  if (searchEndSample - searchStartSample < Math.round((pulse.durationMs / 1_000) * sampleRate)) {
    return null;
  }

  const samples = audioWindow.samples;
  const durationSamples = Math.round((pulse.durationMs / 1_000) * sampleRate);
  const hop = Math.max(32, Math.round(0.004 * sampleRate));
  let bestEnergy = -1;
  let bestAt = searchStartSample;
  for (let start = searchStartSample; start + hop <= searchEndSample; start += hop) {
    let energy = 0;
    for (let index = Math.max(start, 2); index < start + hop; index += 1) {
      const highpassed =
        samples[index] - 2 * samples[index - 1] + samples[index - 2];
      energy += highpassed * highpassed;
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestAt = start;
    }
  }

  // The energy peak lands SOMEWHERE inside the chirp — its tapered center,
  // not its start. The matched filter aligns the template START, which can
  // be up to a full chirp-duration earlier than the energy peak, so the
  // refine window must extend backward by the duration (plus a margin),
  // not just ±25 ms. Searching only forward of the peak silently misses
  // every chirp whose loudest sample is past its onset.
  const refineMargin = Math.round(0.025 * sampleRate);
  return createMatchedToneObservation({
    pulse,
    audioWindow,
    searchStartSample: Math.max(
      searchStartSample,
      bestAt - durationSamples - refineMargin,
    ),
    searchEndSample: Math.min(searchEndSample, bestAt + hop + refineMargin),
    minScore: CHIRP_MIN_SCORE,
    minPeakRatio: CHIRP_MIN_PEAK_RATIO,
  });
}
