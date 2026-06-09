import { rms } from "./delay";

export type TonePulseOptions = {
  frequencyHz: number;
  endFrequencyHz?: number;
  durationMs: number;
  sampleRate: number;
};

export type PulseDetectionOptions = {
  minScore?: number;
  minPeakRatio?: number;
  searchStartSample?: number;
  searchEndSample?: number;
};

export type PulseDetection = {
  startSample: number;
  score: number;
  peakRatio: number;
  confidence: number;
  amplitude: number;
  rms: number;
};

const SCORE_TIE_EPSILON = 0.015;

export function synthesizeTonePulse({
  frequencyHz,
  durationMs,
  sampleRate,
}: TonePulseOptions) {
  return synthesizePulseTemplate({
    frequencyHz,
    durationMs,
    sampleRate,
  });
}

export function synthesizePulseTemplate({
  frequencyHz,
  endFrequencyHz,
  durationMs,
  sampleRate,
}: TonePulseOptions) {
  const length = Math.max(1, Math.round((durationMs / 1_000) * sampleRate));
  const samples = new Float32Array(length);
  const durationSeconds = durationMs / 1_000;
  const sweepHzPerSecond =
    durationSeconds === 0
      ? 0
      : ((endFrequencyHz ?? frequencyHz) - frequencyHz) / durationSeconds;

  for (let index = 0; index < samples.length; index += 1) {
    const seconds = index / sampleRate;
    const phase =
      2 *
      Math.PI *
      (frequencyHz * seconds + 0.5 * sweepHzPerSecond * seconds * seconds);
    const taper =
      samples.length === 1
        ? 1
        : 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (samples.length - 1));
    samples[index] = Math.sin(phase) * taper;
  }

  return samples;
}

export function detectPulse(
  samples: Float32Array | number[],
  template: Float32Array | number[],
  options: PulseDetectionOptions = {},
): PulseDetection | null {
  if (template.length === 0 || samples.length < template.length) {
    return null;
  }

  const minScore = options.minScore ?? 0.52;
  const minPeakRatio = options.minPeakRatio ?? 2.4;
  const start = clampInteger(options.searchStartSample ?? 0, 0, samples.length - 1);
  const end = clampInteger(
    options.searchEndSample ?? samples.length - template.length,
    start,
    samples.length - template.length,
  );
  const templateEnergy = energy(template, 0, template.length);
  if (templateEnergy === 0) {
    return null;
  }

  let bestStart = start;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestStrength = Number.NEGATIVE_INFINITY;

  for (let offset = start; offset <= end; offset += 1) {
    const score = normalizedTemplateScore(samples, template, offset, templateEnergy);
    const strength = score * rmsAt(samples, offset, template.length);
    if (
      score > bestScore + SCORE_TIE_EPSILON ||
      (Math.abs(score - bestScore) <= SCORE_TIE_EPSILON &&
        strength > bestStrength)
    ) {
      bestScore = score;
      bestStrength = strength;
      bestStart = offset;
    }
  }

  const exclusionRadius = Math.max(1, Math.floor(template.length / 2));
  let secondBestStrength = 0;
  for (let offset = start; offset <= end; offset += 1) {
    if (Math.abs(offset - bestStart) <= exclusionRadius) {
      continue;
    }
    const score = normalizedTemplateScore(samples, template, offset, templateEnergy);
    secondBestStrength = Math.max(
      secondBestStrength,
      score * rmsAt(samples, offset, template.length),
    );
  }

  const peakRatio =
    secondBestStrength <= 0
      ? Number.POSITIVE_INFINITY
      : bestStrength / secondBestStrength;
  if (bestScore < minScore || peakRatio < minPeakRatio) {
    return null;
  }

  const segment = samples.slice(bestStart, bestStart + template.length);
  const scoreConfidence = (bestScore - minScore) / Math.max(0.001, 1 - minScore);
  const ratioConfidence =
    peakRatio === Number.POSITIVE_INFINITY
      ? 1
      : (peakRatio - minPeakRatio) / Math.max(0.001, minPeakRatio);
  const gatedPeakConfidence = 0.7 + 0.3 * clamp01(ratioConfidence);

  return {
    startSample: bestStart,
    score: round(bestScore, 4),
    peakRatio: round(peakRatio, 3),
    confidence: round(clamp01(scoreConfidence) * gatedPeakConfidence, 3),
    amplitude: round(maxAbs(segment), 4),
    rms: round(rms(segment), 4),
  };
}

function normalizedTemplateScore(
  samples: Float32Array | number[],
  template: Float32Array | number[],
  start: number,
  templateEnergy: number,
) {
  let dot = 0;
  let segmentEnergy = 0;
  for (let index = 0; index < template.length; index += 1) {
    const sample = samples[start + index];
    const reference = template[index];
    dot += sample * reference;
    segmentEnergy += sample * sample;
  }

  const denominator = Math.sqrt(templateEnergy * segmentEnergy);
  return denominator === 0 ? 0 : dot / denominator;
}

function energy(samples: Float32Array | number[], start: number, length: number) {
  let sum = 0;
  for (let index = start; index < start + length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return sum;
}

function rmsAt(samples: Float32Array | number[], start: number, length: number) {
  return Math.sqrt(energy(samples, start, length) / length);
}

function maxAbs(samples: Float32Array | number[]) {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
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
