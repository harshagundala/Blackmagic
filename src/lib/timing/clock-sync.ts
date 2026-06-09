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
  jitterMs: number;
  quality: number;
  samplesUsed: number;
};

export type AudioFrameTimestampInput = {
  audioContextTimeSeconds: number;
  sampleIndex: number;
  sampleRate: number;
  clientPerfOriginEpochMs: number;
  performanceNowMs: number;
  clockOffsetMs: number;
  clockUncertaintyMs: number;
};

export type AudioFrameTimestamp = AudioFrameTimestampInput & {
  audioElapsedMs: number;
  hostEstimatedEpochMs: number;
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
      jitterMs: Number.POSITIVE_INFINITY,
      quality: 0,
      samplesUsed: 0,
    };
  }

  const keepCount = Math.max(1, Math.ceil(estimates.length * 0.75));
  const kept = estimates.slice(0, keepCount);
  const offsets = kept.map((estimate) => estimate.offsetMs).sort((a, b) => a - b);
  const offsetMs = median(offsets);
  const jitterMs = rms(offsets.map((offset) => offset - offsetMs));
  const bestUncertainty = Math.min(...kept.map((estimate) => estimate.uncertaintyMs));
  const bestRoundTripMs = Math.min(...kept.map((estimate) => estimate.roundTripMs));
  const maxErrorMs = round(bestUncertainty + jitterMs);
  const uncertaintyMs = maxErrorMs;
  const quality = round(Math.max(0, Math.min(1, 1 - maxErrorMs / 100)));

  return {
    offsetMs: round(offsetMs),
    uncertaintyMs,
    maxErrorMs,
    bestRoundTripMs,
    jitterMs: round(jitterMs),
    quality,
    samplesUsed: kept.length,
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
  };
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
