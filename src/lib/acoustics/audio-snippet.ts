// Compact raw-audio snippets exchanged between devices so the room reconciler
// can cross-correlate what each microphone actually heard, instead of trusting
// network clock sync or coarse energy fingerprints. A snippet is a short
// band-limited, decimated, peak-normalized window around a voice edge,
// quantized to 8 bits and base64 encoded (~2.6 KB for 240 ms at 8 kHz).

export type AudioSnippet = {
  // Decimated rate the encoded samples are stored at.
  sampleRate: number;
  // Rate of the capture stream the window was cut from.
  sourceSampleRate: number;
  // Index of the first encoded sample, in the source sample domain.
  startSampleIndex: number;
  // Voice-edge sample the window is centered on, in the source sample domain.
  centerSampleIndex: number;
  windowMs: number;
  // Peak absolute amplitude before normalization; keeps level metadata.
  peakLevel: number;
  // Base64 of Int8 samples normalized to the window peak.
  encodedSamples: string;
};

export type AudioSnippetInput = {
  samples: Float32Array | number[];
  sampleRate: number;
  startSampleIndex: number;
  centerSampleIndex: number;
  windowMs?: number;
  targetSampleRate?: number;
};

export type RawAudioOffsetEstimate = {
  // Positive when the candidate's audio content is later than the reference's
  // relative to each snippet's own window cut. Matches the fingerprint-offset
  // sign convention used by the audio-event reconciler.
  offsetMs: number;
  // |Pearson correlation| of the two windows at the aligned lag, in [0, 1].
  // iOS voice processing can invert capture polarity outright, so alignment
  // strength is judged on magnitude; `polarity` carries the sign.
  correlation: number;
  // Height of the |GCC-PHAT| peak in [0, 1]; sharpness of the alignment.
  phatPeak: number;
  peakRatio: number;
  // +1 when the captures agree in sign, −1 when one side is inverted.
  polarity: 1 | -1;
};

const DEFAULT_WINDOW_MS = 240;
const DEFAULT_TARGET_SAMPLE_RATE = 8_000;
const LOW_PASS_TAPS = 33;
const MIN_PEAK_LEVEL = 1e-4;
const MAX_ENCODED_SAMPLES = 4_096;
const PHAT_EPSILON = 1e-9;

export function captureAudioSnippet({
  samples,
  sampleRate,
  startSampleIndex,
  centerSampleIndex,
  windowMs = DEFAULT_WINDOW_MS,
  targetSampleRate = DEFAULT_TARGET_SAMPLE_RATE,
}: AudioSnippetInput): AudioSnippet | null {
  if (
    sampleRate <= 0 ||
    targetSampleRate <= 0 ||
    windowMs <= 0 ||
    samples.length === 0
  ) {
    return null;
  }

  // Exact-rate windowed-sinc resampling: capture rates differ across devices
  // and modes (iOS voice-processed capture runs at 24 kHz, raw at 48 kHz,
  // routes can flip to 44.1 kHz), and integer decimation would land each on
  // a different effective rate — the cross-device aligner rejects mismatched
  // rates outright. Every snippet therefore lands on targetSampleRate
  // exactly, whatever the source rate.
  const ratio = sampleRate / targetSampleRate;
  const windowSourceSamples = Math.round((windowMs / 1_000) * sampleRate);
  const outputLength = Math.floor(windowSourceSamples / ratio);
  if (outputLength < 8 || outputLength > MAX_ENCODED_SAMPLES) {
    return null;
  }

  const windowStartIndex = Math.round(
    centerSampleIndex - windowSourceSamples / 2,
  );
  const sampleAt = (globalIndex: number) => {
    const localIndex = globalIndex - startSampleIndex;
    return localIndex >= 0 && localIndex < samples.length
      ? samples[localIndex]
      : 0;
  };

  // Anti-alias at 80% of the narrower Nyquist. Kernels for fractional
  // offsets come from a phase-quantized table (1/64-sample steps ≈ 0.3 µs at
  // 48 kHz — far below the cm-scale precision target) so the hot loop runs
  // multiply-adds only; evaluating windowed-sinc trig per tap cost ~260k
  // Math.sin calls per snippet and showed up as main-thread jank on phones.
  const normalizedCutoff =
    (0.8 * (Math.min(targetSampleRate, sampleRate) / 2)) / sampleRate;
  const half = Math.floor(LOW_PASS_TAPS / 2);
  const phases = resampleKernelPhases(normalizedCutoff, half);
  const tapCount = 2 * half + 1;
  const output = new Float32Array(outputLength);
  let peak = 0;
  for (let outIndex = 0; outIndex < outputLength; outIndex += 1) {
    const sourcePosition = windowStartIndex + outIndex * ratio;
    let baseIndex = Math.floor(sourcePosition);
    let phaseIndex = Math.round((sourcePosition - baseIndex) * KERNEL_PHASES);
    if (phaseIndex === KERNEL_PHASES) {
      phaseIndex = 0;
      baseIndex += 1;
    }
    const taps = phases[phaseIndex];
    let value = 0;
    for (let tap = 0; tap < tapCount; tap += 1) {
      value += taps[tap] * sampleAt(baseIndex + tap - half);
    }
    output[outIndex] = value;
    peak = Math.max(peak, Math.abs(value));
  }

  if (!Number.isFinite(peak) || peak <= MIN_PEAK_LEVEL) {
    return null;
  }

  const quantized = new Uint8Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const scaled = Math.round((output[index] / peak) * 127);
    quantized[index] = (Math.max(-127, Math.min(127, scaled)) + 256) % 256;
  }

  return {
    sampleRate: targetSampleRate,
    sourceSampleRate: sampleRate,
    startSampleIndex: windowStartIndex,
    centerSampleIndex: Math.round(centerSampleIndex),
    windowMs: round((windowSourceSamples / sampleRate) * 1_000, 3),
    peakLevel: round(peak, 5),
    encodedSamples: encodeBase64(quantized),
  };
}

export function decodeAudioSnippet(
  snippet: AudioSnippet | null | undefined,
): Float32Array | null {
  if (!snippet || typeof snippet.encodedSamples !== "string") {
    return null;
  }

  const bytes = decodeBase64(snippet.encodedSamples);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_ENCODED_SAMPLES) {
    return null;
  }

  const samples = new Float32Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    const signed = bytes[index] > 127 ? bytes[index] - 256 : bytes[index];
    samples[index] = signed / 127;
  }
  return samples;
}

// GCC-PHAT delay estimation between two snippets cut around each device's own
// voice-edge detection. The phase transform whitens the spectrum so the
// correlation peak stays sharp under reverberation, then a parabolic fit
// recovers the sub-sample lag.
export function estimateRawAudioOffset(
  reference: AudioSnippet | null | undefined,
  candidate: AudioSnippet | null | undefined,
  {
    maxLagMs = 40,
    minFrequencyHz,
    maxFrequencyHz,
  }: {
    maxLagMs?: number;
    // Optional band mask applied to the whitened cross-spectrum. PHAT gives
    // every bin equal weight, so bins where the devices share no coherence
    // (field captures lose inter-device coherence above ~1.5 kHz under iOS
    // voice processing) only add noise to the peak.
    minFrequencyHz?: number;
    maxFrequencyHz?: number;
  } = {},
): RawAudioOffsetEstimate | null {
  if (!reference || !candidate) {
    return null;
  }
  if (
    !compatibleRates(reference.sampleRate, candidate.sampleRate) ||
    reference.sampleRate <= 0
  ) {
    return null;
  }

  const referenceSamples = decodeAudioSnippet(reference);
  const candidateSamples = decodeAudioSnippet(candidate);
  if (!referenceSamples || !candidateSamples) {
    return null;
  }

  const sampleRate = reference.sampleRate;
  const maxLagSamples = Math.min(
    Math.floor((maxLagMs / 1_000) * sampleRate),
    Math.min(referenceSamples.length, candidateSamples.length) - 1,
  );
  if (maxLagSamples < 1) {
    return null;
  }

  const fftSize = nextPowerOfTwo(
    referenceSamples.length + candidateSamples.length,
  );
  const referenceRe = new Float64Array(fftSize);
  const referenceIm = new Float64Array(fftSize);
  const candidateRe = new Float64Array(fftSize);
  const candidateIm = new Float64Array(fftSize);
  referenceRe.set(centered(referenceSamples));
  candidateRe.set(centered(candidateSamples));
  fft(referenceRe, referenceIm, false);
  fft(candidateRe, candidateIm, false);

  // Cross spectrum conj(REF) * CAND with PHAT whitening.
  const crossRe = new Float64Array(fftSize);
  const crossIm = new Float64Array(fftSize);
  for (let bin = 0; bin < fftSize; bin += 1) {
    const binFrequencyHz =
      (Math.min(bin, fftSize - bin) * sampleRate) / fftSize;
    if (
      (minFrequencyHz !== undefined && binFrequencyHz < minFrequencyHz) ||
      (maxFrequencyHz !== undefined && binFrequencyHz > maxFrequencyHz)
    ) {
      continue;
    }
    const re = referenceRe[bin] * candidateRe[bin] + referenceIm[bin] * candidateIm[bin];
    const im = referenceRe[bin] * candidateIm[bin] - referenceIm[bin] * candidateRe[bin];
    const magnitude = Math.hypot(re, im);
    crossRe[bin] = magnitude > PHAT_EPSILON ? re / magnitude : 0;
    crossIm[bin] = magnitude > PHAT_EPSILON ? im / magnitude : 0;
  }
  fft(crossRe, crossIm, true);

  // Peak picking on |correlation|: voice-processed captures can arrive with
  // inverted polarity, which flips the true peak negative while leaving its
  // timing exact.
  const correlationAt = (lag: number) =>
    crossRe[(lag + fftSize) % fftSize] / fftSize;
  const magnitudeAt = (lag: number) => Math.abs(correlationAt(lag));

  let bestLag = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
    const value = magnitudeAt(lag);
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }
  const polarity: 1 | -1 = correlationAt(bestLag) >= 0 ? 1 : -1;

  let secondBest = 0;
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
    if (Math.abs(lag - bestLag) <= 2) {
      continue;
    }
    secondBest = Math.max(secondBest, magnitudeAt(lag));
  }

  const refinedLag = parabolicLag(
    magnitudeAt(bestLag - 1),
    bestValue,
    magnitudeAt(bestLag + 1),
    bestLag,
    maxLagSamples,
  );
  const correlation = pearsonAtLag(referenceSamples, candidateSamples, bestLag);
  if (correlation === null) {
    return null;
  }

  return {
    offsetMs: round((refinedLag / sampleRate) * 1_000, 3),
    correlation: round(Math.abs(correlation), 3),
    phatPeak: round(Math.max(0, Math.min(1, bestValue)), 3),
    peakRatio: round(
      secondBest <= 0 ? Number.POSITIVE_INFINITY : bestValue / secondBest,
      3,
    ),
    polarity,
  };
}

export function isPlausibleAudioSnippet(
  snippet: AudioSnippet | null | undefined,
): snippet is AudioSnippet {
  return Boolean(
    snippet &&
      Number.isFinite(snippet.sampleRate) &&
      snippet.sampleRate > 0 &&
      Number.isFinite(snippet.sourceSampleRate) &&
      snippet.sourceSampleRate > 0 &&
      Number.isFinite(snippet.startSampleIndex) &&
      Number.isFinite(snippet.centerSampleIndex) &&
      Number.isFinite(snippet.windowMs) &&
      snippet.windowMs > 0 &&
      snippet.windowMs <= 1_000 &&
      Number.isFinite(snippet.peakLevel) &&
      snippet.peakLevel >= 0 &&
      typeof snippet.encodedSamples === "string" &&
      snippet.encodedSamples.length > 0 &&
      snippet.encodedSamples.length <= Math.ceil((MAX_ENCODED_SAMPLES / 3) * 4) + 4 &&
      /^[A-Za-z0-9+/=]+$/.test(snippet.encodedSamples),
  );
}

function centered(samples: Float32Array) {
  let mean = 0;
  for (const sample of samples) {
    mean += sample;
  }
  mean /= samples.length;
  const output = new Float64Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = samples[index] - mean;
  }
  return output;
}

function pearsonAtLag(
  reference: Float32Array,
  candidate: Float32Array,
  lag: number,
) {
  let count = 0;
  let referenceSum = 0;
  let candidateSum = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const candidateIndex = index + lag;
    if (candidateIndex < 0 || candidateIndex >= candidate.length) {
      continue;
    }
    count += 1;
    referenceSum += reference[index];
    candidateSum += candidate[candidateIndex];
  }
  if (count < 16) {
    return null;
  }

  const referenceMean = referenceSum / count;
  const candidateMean = candidateSum / count;
  let numerator = 0;
  let referenceEnergy = 0;
  let candidateEnergy = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const candidateIndex = index + lag;
    if (candidateIndex < 0 || candidateIndex >= candidate.length) {
      continue;
    }
    const a = reference[index] - referenceMean;
    const b = candidate[candidateIndex] - candidateMean;
    numerator += a * b;
    referenceEnergy += a * a;
    candidateEnergy += b * b;
  }
  const denominator = Math.sqrt(referenceEnergy * candidateEnergy);
  return denominator === 0 ? null : numerator / denominator;
}

function parabolicLag(
  previous: number,
  peak: number,
  next: number,
  bestLag: number,
  maxLagSamples: number,
) {
  if (Math.abs(bestLag) >= maxLagSamples) {
    return bestLag;
  }
  const curvature = previous - 2 * peak + next;
  if (!(curvature < 0)) {
    return bestLag;
  }
  const offset = (0.5 * (previous - next)) / curvature;
  if (!Number.isFinite(offset)) {
    return bestLag;
  }
  return bestLag + Math.max(-0.5, Math.min(0.5, offset));
}

// Continuous windowed-sinc kernel for fractional-offset resampling.
function resampleKernel(
  offset: number,
  normalizedCutoff: number,
  halfWidth: number,
) {
  const span = halfWidth + 1;
  if (Math.abs(offset) >= span) {
    return 0;
  }
  const sinc =
    offset === 0
      ? 2 * normalizedCutoff
      : Math.sin(2 * Math.PI * normalizedCutoff * offset) / (Math.PI * offset);
  const hamming = 0.54 + 0.46 * Math.cos((Math.PI * offset) / span);
  return sinc * hamming;
}

const KERNEL_PHASES = 64;
const kernelPhaseCache = new Map<string, Float64Array[]>();

// Normalized (unity-DC) kernel tables for each quantized fractional phase,
// cached per cutoff so repeated snippets at the same rates cost nothing.
function resampleKernelPhases(normalizedCutoff: number, halfWidth: number) {
  const key = `${normalizedCutoff.toFixed(8)}|${halfWidth}`;
  const cached = kernelPhaseCache.get(key);
  if (cached) {
    return cached;
  }
  const tapCount = 2 * halfWidth + 1;
  const phases: Float64Array[] = [];
  for (let phase = 0; phase < KERNEL_PHASES; phase += 1) {
    const fraction = phase / KERNEL_PHASES;
    const taps = new Float64Array(tapCount);
    let sum = 0;
    for (let tap = -halfWidth; tap <= halfWidth; tap += 1) {
      const value = resampleKernel(tap - fraction, normalizedCutoff, halfWidth);
      taps[tap + halfWidth] = value;
      sum += value;
    }
    if (sum > 0) {
      for (let index = 0; index < tapCount; index += 1) {
        taps[index] /= sum;
      }
    }
    phases.push(taps);
  }
  kernelPhaseCache.set(key, phases);
  if (kernelPhaseCache.size > 16) {
    const oldest = kernelPhaseCache.keys().next().value;
    if (oldest !== undefined) {
      kernelPhaseCache.delete(oldest);
    }
  }
  return phases;
}

// Iterative radix-2 Cooley-Tukey transform, in place.
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const rootRe = Math.cos(angle);
    const rootIm = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wRe = 1;
      let wIm = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = start + offset + length / 2;
        const oddRe = re[odd] * wRe - im[odd] * wIm;
        const oddIm = re[odd] * wIm + im[odd] * wRe;
        re[odd] = re[even] - oddRe;
        im[odd] = im[even] - oddIm;
        re[even] += oddRe;
        im[even] += oddIm;
        const nextWRe = wRe * rootRe - wIm * rootIm;
        wIm = wRe * rootIm + wIm * rootRe;
        wRe = nextWRe;
      }
    }
  }
}

function nextPowerOfTwo(value: number) {
  let size = 1;
  while (size < value) {
    size <<= 1;
  }
  return size;
}

function compatibleRates(left: number, right: number) {
  return Math.abs(left - right) / Math.max(left, right) < 0.01;
}

function encodeBase64(bytes: Uint8Array) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array | null {
  try {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(encoded, "base64"));
    }
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function round(value: number, decimals: number) {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Number(value.toFixed(decimals));
}
