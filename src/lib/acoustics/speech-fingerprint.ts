export type SpeechFingerprint = {
  sampleRate: number;
  startSampleIndex: number;
  centerSampleIndex: number;
  hopMs: number;
  windowMs: number;
  values: number[];
  alignmentHopMs?: number | null;
  alignmentWindowMs?: number | null;
  alignmentValues?: number[] | null;
};

export type SpeechFingerprintInput = {
  samples: Float32Array | number[];
  sampleRate: number;
  startSampleIndex: number;
  centerSampleIndex: number;
  windowMs?: number;
  bins?: number;
  alignmentBins?: number;
};

export type FingerprintOffsetEstimate = {
  offsetMs: number;
  lagBins: number;
  correlation: number;
  source: "alignment-sketch" | "energy-contour";
};

export function createSpeechFingerprint({
  samples,
  sampleRate,
  startSampleIndex,
  centerSampleIndex,
  windowMs = 240,
  bins = 32,
  alignmentBins,
}: SpeechFingerprintInput): SpeechFingerprint | null {
  if (
    sampleRate <= 0 ||
    samples.length === 0 ||
    bins <= 0 ||
    windowMs <= 0
  ) {
    return null;
  }

  const windowSamples = Math.max(1, Math.round((windowMs / 1_000) * sampleRate));
  const binSamples = Math.max(1, Math.floor(windowSamples / bins));
  const actualWindowSamples = binSamples * bins;
  const fingerprintStartSampleIndex =
    Math.round(centerSampleIndex - actualWindowSamples / 2);
  const values: number[] = [];

  for (let bin = 0; bin < bins; bin += 1) {
    const binStartSampleIndex = fingerprintStartSampleIndex + bin * binSamples;
    let squareSum = 0;
    for (let offset = 0; offset < binSamples; offset += 1) {
      const globalSampleIndex = binStartSampleIndex + offset;
      const localSampleIndex = globalSampleIndex - startSampleIndex;
      const sample =
        localSampleIndex >= 0 && localSampleIndex < samples.length
          ? samples[localSampleIndex]
          : 0;
      squareSum += sample * sample;
    }
    values.push(Math.sqrt(squareSum / binSamples));
  }

  const peak = Math.max(...values);
  if (!Number.isFinite(peak) || peak <= 0) {
    return null;
  }

  const alignment = alignmentBins
    ? createAlignmentSketch({
        samples,
        sampleRate,
        startSampleIndex,
        centerSampleIndex,
        windowMs,
        bins: alignmentBins,
      })
    : null;

  return {
    sampleRate,
    startSampleIndex: fingerprintStartSampleIndex,
    centerSampleIndex: Math.round(centerSampleIndex),
    hopMs: round((binSamples / sampleRate) * 1_000),
    windowMs: round((actualWindowSamples / sampleRate) * 1_000),
    values: values.map((value) => round(value / peak)),
    alignmentHopMs: alignment?.hopMs ?? null,
    alignmentWindowMs: alignment?.windowMs ?? null,
    alignmentValues: alignment?.values ?? null,
  };
}

export function estimateFingerprintOffset(
  reference: SpeechFingerprint | null | undefined,
  candidate: SpeechFingerprint | null | undefined,
  {
    maxLagBins = 8,
    maxAlignmentLagBins = 16,
  }: { maxLagBins?: number; maxAlignmentLagBins?: number } = {},
): FingerprintOffsetEstimate | null {
  if (
    !reference ||
    !candidate ||
    reference.values.length === 0 ||
    candidate.values.length === 0
  ) {
    return null;
  }

  const alignment = estimateAlignmentSketchOffset(
    reference,
    candidate,
    maxAlignmentLagBins,
  );
  if (alignment && alignment.correlation >= 0.35) {
    return alignment;
  }

  const maxLag = Math.max(0, Math.round(maxLagBins));
  let best: FingerprintOffsetEstimate | null = null;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const correlation = normalizedCorrelation(
      reference.values,
      candidate.values,
      lag,
    );
    if (correlation === null) {
      continue;
    }
    if (!best || correlation > best.correlation) {
      best = {
        offsetMs: round(lag * candidate.hopMs),
        lagBins: lag,
        correlation: round(correlation),
        source: "energy-contour",
      };
    }
  }

  return best;
}

function createAlignmentSketch({
  samples,
  sampleRate,
  startSampleIndex,
  centerSampleIndex,
  windowMs,
  bins,
}: Required<Pick<SpeechFingerprintInput, "sampleRate" | "startSampleIndex" | "centerSampleIndex" | "windowMs" | "bins">> & {
  samples: Float32Array | number[];
}) {
  const windowSamples = Math.max(1, Math.round((windowMs / 1_000) * sampleRate));
  const binSamples = Math.max(1, Math.floor(windowSamples / bins));
  const actualWindowSamples = binSamples * bins;
  const sketchStartSampleIndex = Math.round(centerSampleIndex - actualWindowSamples / 2);
  const values: number[] = [];

  for (let bin = 0; bin < bins; bin += 1) {
    const binStartSampleIndex = sketchStartSampleIndex + bin * binSamples;
    let total = 0;
    for (let offset = 0; offset < binSamples; offset += 1) {
      const globalSampleIndex = binStartSampleIndex + offset;
      const localSampleIndex = globalSampleIndex - startSampleIndex;
      total +=
        localSampleIndex >= 0 && localSampleIndex < samples.length
          ? samples[localSampleIndex]
          : 0;
    }
    values.push(total / binSamples);
  }

  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  const peak = Math.max(...centered.map((value) => Math.abs(value)));
  if (!Number.isFinite(peak) || peak <= 0) {
    return null;
  }

  return {
    hopMs: round((binSamples / sampleRate) * 1_000),
    windowMs: round((actualWindowSamples / sampleRate) * 1_000),
    values: centered.map((value) => round(value / peak)),
  };
}

function estimateAlignmentSketchOffset(
  reference: SpeechFingerprint,
  candidate: SpeechFingerprint,
  maxLagBins: number,
): FingerprintOffsetEstimate | null {
  if (
    !reference.alignmentValues ||
    !candidate.alignmentValues ||
    reference.alignmentValues.length === 0 ||
    candidate.alignmentValues.length === 0 ||
    !candidate.alignmentHopMs
  ) {
    return null;
  }

  const maxLag = Math.max(0, Math.round(maxLagBins));
  let best: FingerprintOffsetEstimate | null = null;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const correlation = normalizedCorrelation(
      reference.alignmentValues,
      candidate.alignmentValues,
      lag,
    );
    if (correlation === null) {
      continue;
    }
    if (!best || correlation > best.correlation) {
      best = {
        offsetMs: round(lag * candidate.alignmentHopMs),
        lagBins: lag,
        correlation: round(correlation),
        source: "alignment-sketch",
      };
    }
  }

  return best;
}

function normalizedCorrelation(
  reference: number[],
  candidate: number[],
  lagBins: number,
) {
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index < reference.length; index += 1) {
    const candidateIndex = index + lagBins;
    if (candidateIndex < 0 || candidateIndex >= candidate.length) {
      continue;
    }
    pairs.push([reference[index], candidate[candidateIndex]]);
  }

  if (pairs.length < 3) {
    return null;
  }

  const referenceMean =
    pairs.reduce((total, [value]) => total + value, 0) / pairs.length;
  const candidateMean =
    pairs.reduce((total, [, value]) => total + value, 0) / pairs.length;
  let numerator = 0;
  let referenceEnergy = 0;
  let candidateEnergy = 0;
  for (const [referenceValue, candidateValue] of pairs) {
    const referenceCentered = referenceValue - referenceMean;
    const candidateCentered = candidateValue - candidateMean;
    numerator += referenceCentered * candidateCentered;
    referenceEnergy += referenceCentered * referenceCentered;
    candidateEnergy += candidateCentered * candidateCentered;
  }

  if (referenceEnergy <= 0 || candidateEnergy <= 0) {
    return null;
  }

  return numerator / Math.sqrt(referenceEnergy * candidateEnergy);
}

function round(value: number) {
  return Number(value.toFixed(3));
}
