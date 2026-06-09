export type ClockExchange = {
  clientPerfOriginEpochMs: number;
  clientSendPerfMs: number;
  serverReceiveEpochMs: number;
  serverSendEpochMs: number;
  clientReceivePerfMs: number;
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

export function robustClockModel(exchanges: ClockExchange[]): ClockModel {
  const estimates = exchanges
    .map(estimateClockOffset)
    .sort((a, b) => a.roundTripMs - b.roundTripMs);

  if (estimates.length === 0) {
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
    };
  }

  const offsetMedian = median(
    estimates.map((estimate) => estimate.offsetMs).sort((a, b) => a - b),
  );
  const deviations = estimates
    .map((estimate) => Math.abs(estimate.offsetMs - offsetMedian))
    .sort((a, b) => a - b);
  const medianDeviation = median(deviations);
  const offsetOutlierThresholdMs = Math.max(6, medianDeviation * 3);
  const offsetFiltered = estimates.filter(
    (estimate) =>
      Math.abs(estimate.offsetMs - offsetMedian) <= offsetOutlierThresholdMs,
  );
  const outliersRejected = estimates.length - offsetFiltered.length;
  const keepCount = Math.max(1, Math.ceil(estimates.length * 0.75));
  const kept = (offsetFiltered.length > 0 ? offsetFiltered : estimates)
    .sort((a, b) => a.roundTripMs - b.roundTripMs)
    .slice(0, keepCount);
  const offsets = kept.map((estimate) => estimate.offsetMs).sort((a, b) => a - b);
  const offsetMs = median(offsets);
  const jitterMs = rms(offsets.map((offset) => offset - offsetMs));
  const bestUncertainty = Math.min(...kept.map((estimate) => estimate.uncertaintyMs));
  const bestRoundTripMs = Math.min(...kept.map((estimate) => estimate.roundTripMs));
  const worstAcceptedRoundTripMs = Math.max(
    ...kept.map((estimate) => estimate.roundTripMs),
  );
  const maxErrorMs = round(bestUncertainty + jitterMs);
  const uncertaintyMs = maxErrorMs;
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
