export type ClockExchange = {
  clientPerfOriginEpochMs: number;
  clientSendPerfMs: number;
  serverReceiveEpochMs: number;
  serverSendEpochMs: number;
  clientReceivePerfMs: number;
  // Identifies which server process answered. Serverless platforms run many
  // instances whose Date.now() baselines differ; offsets are only comparable
  // within one instance.
  serverInstanceId?: string | null;
};

export type ClockOffsetEstimate = {
  offsetMs: number;
  roundTripMs: number;
  uncertaintyMs: number;
};

export type ClockExchangeRetentionOptions = {
  maxRoundTripMs?: number;
  maxSamples?: number;
};

export type ClockModel = {
  offsetMs: number;
  uncertaintyMs: number;
  maxErrorMs: number;
  bestRoundTripMs: number;
  worstAcceptedRoundTripMs: number;
  jitterMs: number;
  offsetStabilityMs: number;
  quality: number;
  samplesUsed: number;
  outliersRejected: number;
  // Samples discarded because they came from a different server instance than
  // the dominant one; their offsets are not comparable.
  crossInstanceRejected: number;
  // Measured relative clock drift between this device and the server, in
  // milliseconds of offset change per second of elapsed time. Zero when the
  // exchange history is too short to fit a slope.
  driftMsPerSecond: number;
  // performance.now() of the newest exchange used by the model; lets callers
  // age the model with projectClockModel().
  referencePerfMs: number | null;
  sampleSpanMs: number;
};

export type ProjectedClock = {
  offsetMs: number;
  uncertaintyMs: number;
  maxErrorMs: number;
  ageMs: number;
};

export type AudioFrameTimestampInput = {
  audioContextTimeSeconds: number;
  sampleIndex: number;
  sampleRate: number;
  clientPerfOriginEpochMs: number;
  performanceNowMs: number;
  clockOffsetMs: number;
  clockUncertaintyMs: number;
  clockQuality?: number | null;
  clockMaxErrorMs?: number | null;
  clockBestRoundTripMs?: number | null;
  clockJitterMs?: number | null;
  clockSamplesUsed?: number | null;
  clockOutliersRejected?: number | null;
  clockOffsetStabilityMs?: number | null;
};

export type AudioFrameTimestamp = AudioFrameTimestampInput & {
  audioElapsedMs: number;
  hostEstimatedEpochMs: number;
  timingConfidence: number;
};

export type AudioSampleTimestampInput = Omit<
  AudioFrameTimestampInput,
  "audioContextTimeSeconds" | "performanceNowMs"
> & {
  anchorAudioContextTimeSeconds: number;
  anchorPerformanceNowMs: number;
};

export function estimateClockOffset(exchange: ClockExchange): ClockOffsetEstimate {
  const clientSendEpochMs =
    exchange.clientPerfOriginEpochMs + exchange.clientSendPerfMs;
  const clientReceiveEpochMs =
    exchange.clientPerfOriginEpochMs + exchange.clientReceivePerfMs;
  const serverProcessingMs =
    exchange.serverSendEpochMs - exchange.serverReceiveEpochMs;
  const roundTripMs =
    clientReceiveEpochMs - clientSendEpochMs - Math.max(0, serverProcessingMs);
  const clientMidpointMs = (clientSendEpochMs + clientReceiveEpochMs) / 2;
  const serverMidpointMs =
    (exchange.serverReceiveEpochMs + exchange.serverSendEpochMs) / 2;

  return {
    offsetMs: round(serverMidpointMs - clientMidpointMs),
    roundTripMs: round(roundTripMs),
    uncertaintyMs: round(Math.max(0, roundTripMs / 2)),
  };
}

export function retainClockExchanges(
  history: ClockExchange[],
  exchange: ClockExchange,
  {
    maxRoundTripMs = 750,
    maxSamples = 24,
  }: ClockExchangeRetentionOptions = {},
): ClockExchange[] {
  const next = estimateClockOffset(exchange);
  const candidates =
    next.roundTripMs <= maxRoundTripMs ? [...history, exchange] : history;

  return candidates
    .filter((item) => estimateClockOffset(item).roundTripMs <= maxRoundTripMs)
    .slice(-maxSamples);
}

const MIN_DRIFT_FIT_SAMPLES = 6;
const MIN_DRIFT_FIT_SPAN_MS = 4_000;
const MAX_PLAUSIBLE_DRIFT_MS_PER_SECOND = 0.5;
// Allowance for unmodeled drift while the model ages, roughly a 60 ppm
// crystal mismatch, used when no drift slope could be fitted.
const DEFAULT_DRIFT_ALLOWANCE_MS_PER_SECOND = 0.06;

type EstimatePair = {
  estimate: ClockOffsetEstimate;
  exchange: ClockExchange;
};

export function robustClockModel(exchanges: ClockExchange[]): ClockModel {
  const allPairs: EstimatePair[] = exchanges.map((exchange) => ({
    estimate: estimateClockOffset(exchange),
    exchange,
  }));
  const pairs = dominantInstancePairs(allPairs);
  const crossInstanceRejected = allPairs.length - pairs.length;

  if (pairs.length === 0) {
    return {
      offsetMs: 0,
      uncertaintyMs: Number.POSITIVE_INFINITY,
      maxErrorMs: Number.POSITIVE_INFINITY,
      bestRoundTripMs: Number.POSITIVE_INFINITY,
      worstAcceptedRoundTripMs: Number.POSITIVE_INFINITY,
      jitterMs: Number.POSITIVE_INFINITY,
      offsetStabilityMs: Number.POSITIVE_INFINITY,
      quality: 0,
      samplesUsed: 0,
      outliersRejected: 0,
      crossInstanceRejected,
      driftMsPerSecond: 0,
      referencePerfMs: null,
      sampleSpanMs: 0,
    };
  }

  const estimates = pairs
    .map((pair) => pair.estimate)
    .sort((a, b) => a.roundTripMs - b.roundTripMs);
  const offsetMedian = median(
    estimates.map((estimate) => estimate.offsetMs).sort((a, b) => a - b),
  );
  const deviations = estimates
    .map((estimate) => Math.abs(estimate.offsetMs - offsetMedian))
    .sort((a, b) => a - b);
  const medianDeviation = median(deviations);
  const offsetOutlierThresholdMs = Math.max(6, medianDeviation * 3);
  const offsetFiltered = pairs.filter(
    (pair) =>
      Math.abs(pair.estimate.offsetMs - offsetMedian) <=
      offsetOutlierThresholdMs,
  );
  const outliersRejected = pairs.length - offsetFiltered.length;
  const keepCount = Math.max(1, Math.ceil(pairs.length * 0.75));
  const kept = (offsetFiltered.length > 0 ? offsetFiltered : pairs)
    .sort((a, b) => a.estimate.roundTripMs - b.estimate.roundTripMs)
    .slice(0, keepCount);
  const referencePerfMs = Math.max(
    ...kept.map((pair) => pair.exchange.clientReceivePerfMs),
  );
  const sampleSpanMs =
    referencePerfMs -
    Math.min(...kept.map((pair) => pair.exchange.clientReceivePerfMs));

  const drift = fitDrift(kept, referencePerfMs);
  const offsets = kept
    .map((pair) => pair.estimate.offsetMs)
    .sort((a, b) => a - b);
  const offsetMs = drift ? drift.offsetAtReferenceMs : median(offsets);
  const jitterMs = drift
    ? drift.residualRmsMs
    : rms(offsets.map((offset) => offset - offsetMs));
  const bestUncertainty = Math.min(
    ...kept.map((pair) => pair.estimate.uncertaintyMs),
  );
  const bestRoundTripMs = Math.min(
    ...kept.map((pair) => pair.estimate.roundTripMs),
  );
  const worstAcceptedRoundTripMs = Math.max(
    ...kept.map((pair) => pair.estimate.roundTripMs),
  );
  // uncertaintyMs is a one-sigma style figure; maxErrorMs is the conservative
  // bound: the best exchange's half round trip (NTP offset error bound) plus
  // twice the observed scatter.
  const uncertaintyMs = round(
    Math.sqrt((bestUncertainty / 2) ** 2 + jitterMs ** 2),
  );
  const maxErrorMs = round(bestUncertainty + 2 * jitterMs);
  const quality = round(Math.max(0, Math.min(1, 1 - maxErrorMs / 100)));

  return {
    offsetMs: round(offsetMs),
    uncertaintyMs,
    maxErrorMs,
    bestRoundTripMs,
    worstAcceptedRoundTripMs,
    jitterMs: round(jitterMs),
    offsetStabilityMs: round(jitterMs),
    quality,
    samplesUsed: kept.length,
    outliersRejected,
    crossInstanceRejected,
    driftMsPerSecond: drift ? round(drift.slopeMsPerSecond) : 0,
    referencePerfMs: round(referencePerfMs),
    sampleSpanMs: round(sampleSpanMs),
  };
}

// Ages a clock model to "now": applies the fitted drift slope to the offset
// and widens the error bounds for unmodeled drift since the last exchange.
export function projectClockModel(
  model: ClockModel,
  nowPerfMs: number,
): ProjectedClock {
  if (
    model.referencePerfMs === null ||
    !Number.isFinite(nowPerfMs) ||
    !Number.isFinite(model.uncertaintyMs)
  ) {
    return {
      offsetMs: model.offsetMs,
      uncertaintyMs: model.uncertaintyMs,
      maxErrorMs: model.maxErrorMs,
      ageMs: 0,
    };
  }

  const ageMs = Math.max(0, nowPerfMs - model.referencePerfMs);
  const ageSeconds = ageMs / 1_000;
  const driftAllowancePerSecond =
    model.driftMsPerSecond === 0
      ? DEFAULT_DRIFT_ALLOWANCE_MS_PER_SECOND
      : Math.max(0.02, Math.abs(model.driftMsPerSecond) * 0.35);
  const growthMs = driftAllowancePerSecond * ageSeconds;

  return {
    offsetMs: round(model.offsetMs + model.driftMsPerSecond * ageSeconds),
    uncertaintyMs: round(model.uncertaintyMs + growthMs),
    maxErrorMs: round(model.maxErrorMs + growthMs),
    ageMs: round(ageMs),
  };
}

function dominantInstancePairs(pairs: EstimatePair[]): EstimatePair[] {
  const groups = new Map<string, EstimatePair[]>();
  for (const pair of pairs) {
    const key = pair.exchange.serverInstanceId ?? "unknown";
    const group = groups.get(key) ?? [];
    group.push(pair);
    groups.set(key, group);
  }

  let dominant: EstimatePair[] = [];
  let dominantLatest = Number.NEGATIVE_INFINITY;
  for (const group of groups.values()) {
    const latest = Math.max(
      ...group.map((pair) => pair.exchange.clientReceivePerfMs),
    );
    if (
      group.length > dominant.length ||
      (group.length === dominant.length && latest > dominantLatest)
    ) {
      dominant = group;
      dominantLatest = latest;
    }
  }

  return dominant;
}

function fitDrift(pairs: EstimatePair[], referencePerfMs: number) {
  if (pairs.length < MIN_DRIFT_FIT_SAMPLES) {
    return null;
  }

  const times = pairs.map((pair) => pair.exchange.clientReceivePerfMs);
  const spanMs = Math.max(...times) - Math.min(...times);
  if (spanMs < MIN_DRIFT_FIT_SPAN_MS) {
    return null;
  }

  const meanTime = times.reduce((sum, value) => sum + value, 0) / times.length;
  const offsets = pairs.map((pair) => pair.estimate.offsetMs);
  const meanOffset =
    offsets.reduce((sum, value) => sum + value, 0) / offsets.length;

  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    const dt = times[index] - meanTime;
    covariance += dt * (offsets[index] - meanOffset);
    variance += dt * dt;
  }
  if (variance === 0) {
    return null;
  }

  const slopeMsPerMs = covariance / variance;
  const slopeMsPerSecond = slopeMsPerMs * 1_000;
  if (Math.abs(slopeMsPerSecond) > MAX_PLAUSIBLE_DRIFT_MS_PER_SECOND) {
    return null;
  }

  const offsetAtReferenceMs =
    meanOffset + slopeMsPerMs * (referencePerfMs - meanTime);
  const residuals = pairs.map((pair, index) => {
    const predicted = meanOffset + slopeMsPerMs * (times[index] - meanTime);
    return pair.estimate.offsetMs - predicted;
  });

  return {
    slopeMsPerSecond,
    offsetAtReferenceMs,
    residualRmsMs: rms(residuals),
  };
}

export function audioSampleTimestamp(
  input: AudioSampleTimestampInput,
): AudioFrameTimestamp {
  const audioContextTimeSeconds = input.sampleIndex / input.sampleRate;
  const performanceNowMs =
    input.anchorPerformanceNowMs +
    (audioContextTimeSeconds - input.anchorAudioContextTimeSeconds) * 1_000;

  return audioFrameTimestamp({
    audioContextTimeSeconds,
    sampleIndex: input.sampleIndex,
    sampleRate: input.sampleRate,
    clientPerfOriginEpochMs: input.clientPerfOriginEpochMs,
    performanceNowMs,
    clockOffsetMs: input.clockOffsetMs,
    clockUncertaintyMs: input.clockUncertaintyMs,
    clockQuality: input.clockQuality,
    clockMaxErrorMs: input.clockMaxErrorMs,
    clockBestRoundTripMs: input.clockBestRoundTripMs,
    clockJitterMs: input.clockJitterMs,
    clockSamplesUsed: input.clockSamplesUsed,
    clockOutliersRejected: input.clockOutliersRejected,
    clockOffsetStabilityMs: input.clockOffsetStabilityMs,
  });
}

export function audioFrameTimestamp(
  input: AudioFrameTimestampInput,
): AudioFrameTimestamp {
  const audioElapsedMs = (input.sampleIndex / input.sampleRate) * 1_000;
  const clientEstimatedEpochMs =
    input.clientPerfOriginEpochMs + input.performanceNowMs;

  return {
    ...input,
    audioElapsedMs: round(audioElapsedMs),
    hostEstimatedEpochMs: round(clientEstimatedEpochMs + input.clockOffsetMs),
    timingConfidence: timestampConfidence(input),
  };
}

export function timestampConfidence(
  input: Pick<
    AudioFrameTimestampInput,
    | "clockUncertaintyMs"
    | "clockQuality"
    | "clockMaxErrorMs"
    | "clockBestRoundTripMs"
    | "clockJitterMs"
    | "clockSamplesUsed"
    | "clockOffsetStabilityMs"
  >,
) {
  const uncertaintyMs = Math.max(
    0,
    finiteOr(input.clockUncertaintyMs, Number.POSITIVE_INFINITY),
    finiteOr(input.clockMaxErrorMs, 0),
  );
  const uncertaintyScore = 1 / (1 + uncertaintyMs / 18);
  const qualityScore = clamp(finiteOr(input.clockQuality, 0.5), 0, 1);
  const samplesUsed = finiteOr(input.clockSamplesUsed, 0);
  const sampleScore = clamp(samplesUsed / 6, 0.12, 1);
  const roundTripScore =
    1 / (1 + Math.max(0, finiteOr(input.clockBestRoundTripMs, 60)) / 80);
  const stabilityMs = Math.max(
    0,
    finiteOr(input.clockJitterMs, 4),
    finiteOr(input.clockOffsetStabilityMs, 4),
  );
  const stabilityScore = 1 / (1 + stabilityMs / 8);
  const baseScore =
    uncertaintyScore * 0.52 +
    qualityScore * 0.22 +
    sampleScore * 0.1 +
    roundTripScore * 0.08 +
    stabilityScore * 0.08;
  const evidencePenalty =
    sampleScore * (0.55 + roundTripScore * 0.45) * (0.45 + stabilityScore * 0.55);

  return round(clamp(baseScore * evidencePenalty, 0, 1));
}

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle];
  }
  return (values[middle - 1] + values[middle]) / 2;
}

function rms(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const meanSquare =
    values.reduce((total, value) => total + value * value, 0) / values.length;
  return Math.sqrt(meanSquare);
}

function round(value: number) {
  return Number(value.toFixed(3));
}

function finiteOr(value: number | null | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
