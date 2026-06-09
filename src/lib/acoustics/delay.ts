export type DelayEstimate = {
  lagSamples: number;
  confidence: number;
  score: number;
};

export type DelayEstimateOptions = {
  maxLag: number;
};

const SPEED_OF_SOUND_METERS_PER_SECOND = 343;

export function rms(samples: Float32Array | number[]) {
  if (samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples.length);
}

export function lagSamplesToMeters(
  lagSamples: number,
  sampleRate: number,
  speedOfSoundMetersPerSecond = SPEED_OF_SOUND_METERS_PER_SECOND,
) {
  return Math.abs(lagSamples / sampleRate) * speedOfSoundMetersPerSecond;
}

export function estimateDelaySamples(
  reference: Float32Array | number[],
  observed: Float32Array | number[],
  options: DelayEstimateOptions,
): DelayEstimate {
  if (reference.length !== observed.length) {
    throw new Error("Delay estimation requires equal-length sample windows.");
  }

  if (reference.length === 0) {
    return { lagSamples: 0, confidence: 0, score: 0 };
  }

  let bestLag = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  let secondBestScore = Number.NEGATIVE_INFINITY;

  for (let lag = -options.maxLag; lag <= options.maxLag; lag += 1) {
    const score = normalizedCorrelation(reference, observed, lag);

    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestLag = lag;
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  const separation = Math.max(0, bestScore - Math.max(0, secondBestScore));
  const confidence = Math.max(0, Math.min(1, bestScore * 0.85 + separation));

  return {
    lagSamples: bestLag,
    confidence,
    score: bestScore,
  };
}

function normalizedCorrelation(
  reference: Float32Array | number[],
  observed: Float32Array | number[],
  lag: number,
) {
  let dot = 0;
  let referenceEnergy = 0;
  let observedEnergy = 0;

  for (let i = 0; i < reference.length; i += 1) {
    const observedIndex = i + lag;
    if (observedIndex < 0 || observedIndex >= observed.length) {
      continue;
    }

    const a = reference[i];
    const b = observed[observedIndex];
    dot += a * b;
    referenceEnergy += a * a;
    observedEnergy += b * b;
  }

  const denominator = Math.sqrt(referenceEnergy * observedEnergy);
  return denominator === 0 ? 0 : dot / denominator;
}
