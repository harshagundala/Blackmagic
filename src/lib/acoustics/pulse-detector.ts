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
  quadratureTemplate?: Float32Array | number[];
};

export type PulseDetection = {
  startSample: number;
  refinedStartSample: number;
  score: number;
  peakRatio: number;
  confidence: number;
  amplitude: number;
  rms: number;
};

const SCORE_TIE_EPSILON = 0.015;

// Confidence reference for the envelope score. A matched filter never scores
// anywhere near 1.0 on real room audio — multipath, transducer rolloff, and
// in-band noise cap clean phone-to-phone chirp receptions around 0.2-0.5
// (measured on field recordings), while template-free windows score below
// 0.01. Normalizing against this achievable reference makes confidence mean
// "how clearly was the pulse seen" instead of "how loud was it" — a quiet
// reception with an unambiguous correlation peak is strong evidence.
const REFERENCE_ENVELOPE_SCORE = 0.3;

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

export function synthesizePulseTemplate(options: TonePulseOptions) {
  return synthesizePhasedPulseTemplate(options, 0);
}

// The quadrature (90-degree shifted) copy of the template lets the detector
// score the correlation envelope instead of the raw carrier. Near Nyquist the
// real correlation oscillates at the carrier period, so envelope scoring is
// what prevents the matcher from locking onto a neighboring carrier cycle and
// keeps detection robust to phase shifts from device audio processing.
export function synthesizeQuadraturePulseTemplate(options: TonePulseOptions) {
  return synthesizePhasedPulseTemplate(options, Math.PI / 2);
}

function synthesizePhasedPulseTemplate(
  {
    frequencyHz,
    endFrequencyHz,
    durationMs,
    sampleRate,
  }: TonePulseOptions,
  phaseOffsetRadians: number,
) {
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
        (frequencyHz * seconds + 0.5 * sweepHzPerSecond * seconds * seconds) +
      phaseOffsetRadians;
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

  const quadrature = options.quadratureTemplate ?? null;
  const quadratureEnergy =
    quadrature && quadrature.length === template.length
      ? energy(quadrature, 0, quadrature.length)
      : 0;
  const scoreAt =
    quadrature && quadratureEnergy > 0
      ? (offset: number) =>
          envelopeTemplateScore(
            samples,
            template,
            quadrature,
            offset,
            (templateEnergy + quadratureEnergy) / 2,
          )
      : (offset: number) =>
          normalizedTemplateScore(samples, template, offset, templateEnergy);

  let bestStart = start;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestStrength = Number.NEGATIVE_INFINITY;

  for (let offset = start; offset <= end; offset += 1) {
    const score = scoreAt(offset);
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
    secondBestStrength = Math.max(
      secondBestStrength,
      scoreAt(offset) * rmsAt(samples, offset, template.length),
    );
  }

  const peakRatio =
    secondBestStrength <= 0
      ? Number.POSITIVE_INFINITY
      : bestStrength / secondBestStrength;
  if (bestScore < minScore || peakRatio < minPeakRatio) {
    return null;
  }

  const refinedStartSample = refinePeakSample(
    scoreAt,
    bestStart,
    start,
    end,
    bestScore,
  );
  const segment = samples.slice(bestStart, bestStart + template.length);
  const scoreConfidence = clamp01(bestScore / REFERENCE_ENVELOPE_SCORE);
  const ratioConfidence =
    peakRatio === Number.POSITIVE_INFINITY
      ? 1
      : (peakRatio - minPeakRatio) / Math.max(0.001, minPeakRatio);
  const gatedPeakConfidence = 0.7 + 0.3 * clamp01(ratioConfidence);

  return {
    startSample: bestStart,
    refinedStartSample: round(refinedStartSample, 3),
    score: round(bestScore, 4),
    peakRatio: round(peakRatio, 3),
    confidence: round(clamp01(scoreConfidence) * gatedPeakConfidence, 3),
    amplitude: round(maxAbs(segment), 4),
    rms: round(rms(segment), 4),
  };
}

function refinePeakSample(
  scoreAt: (offset: number) => number,
  bestStart: number,
  searchStart: number,
  searchEnd: number,
  bestScore: number,
) {
  if (bestStart <= searchStart || bestStart >= searchEnd) {
    return bestStart;
  }

  const previous = scoreAt(bestStart - 1);
  const next = scoreAt(bestStart + 1);
  const curvature = previous - 2 * bestScore + next;
  if (!(curvature < 0)) {
    return bestStart;
  }

  // Parabolic vertex of the three-point correlation neighborhood; the true
  // peak of a band-limited correlation can sit between integer lags.
  const offset = (0.5 * (previous - next)) / curvature;
  if (!Number.isFinite(offset)) {
    return bestStart;
  }

  return bestStart + Math.max(-0.5, Math.min(0.5, offset));
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

function envelopeTemplateScore(
  samples: Float32Array | number[],
  inPhase: Float32Array | number[],
  quadrature: Float32Array | number[],
  start: number,
  meanTemplateEnergy: number,
) {
  let dotI = 0;
  let dotQ = 0;
  let segmentEnergy = 0;
  for (let index = 0; index < inPhase.length; index += 1) {
    const sample = samples[start + index];
    dotI += sample * inPhase[index];
    dotQ += sample * quadrature[index];
    segmentEnergy += sample * sample;
  }

  const denominator = Math.sqrt(meanTemplateEnergy * segmentEnergy);
  return denominator === 0
    ? 0
    : Math.sqrt(dotI * dotI + dotQ * dotQ) / denominator;
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
