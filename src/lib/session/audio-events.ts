import {
  estimateFingerprintOffset,
  type SpeechFingerprint,
} from "../acoustics/speech-fingerprint";

export type VoiceActivityEvent = {
  id: string;
  detectedAtHostEpochMs: number;
  audioContextTimeSeconds: number;
  sampleIndex: number;
  sampleRate: number;
  audioLevel: number;
  confidence: number;
  clockOffsetMs: number;
  clockUncertaintyMs: number;
  clockQuality?: number | null;
  clockMaxErrorMs?: number | null;
  clockBestRoundTripMs?: number | null;
  clockJitterMs?: number | null;
  clockSamplesUsed?: number | null;
  clockOutliersRejected?: number | null;
  clockOffsetStabilityMs?: number | null;
  timingConfidence?: number | null;
  motionStability?: number | null;
  audioFingerprint?: SpeechFingerprint | null;
};

export type AudioEventDevice = {
  deviceId: string;
  voiceEvent?: VoiceActivityEvent | null;
  voiceEvents?: VoiceActivityEvent[] | null;
};

export type ReconciledAudioEventObservation = {
  deviceId: string;
  eventId: string;
  detectedAtHostEpochMs: number;
  sampleIndex: number;
  sampleRate: number;
  audioLevel: number;
  confidence: number;
  clockUncertaintyMs: number;
  clockQuality?: number | null;
  clockMaxErrorMs?: number | null;
  clockBestRoundTripMs?: number | null;
  clockJitterMs?: number | null;
  clockSamplesUsed?: number | null;
  clockOutliersRejected?: number | null;
  clockOffsetStabilityMs?: number | null;
  timingConfidence?: number | null;
  motionStability?: number | null;
  audioFingerprint?: SpeechFingerprint | null;
  fingerprintOffsetMs?: number | null;
  fingerprintCorrelation?: number | null;
  refinedDetectedAtHostEpochMs?: number | null;
};

export type ReconciledAudioEvent = {
  id: string;
  startedAtHostEpochMs: number;
  endedAtHostEpochMs: number;
  centerHostEpochMs: number;
  timeSpreadMs: number;
  arrivalLeaderDeviceId: string;
  observedDeviceIds: string[];
  observations: ReconciledAudioEventObservation[];
  timestampUncertaintyMs: number;
  timingConfidence: number;
  fingerprintAlignmentConfidence?: number | null;
  confidence: number;
};

export type AudioEventReconciliationOptions = {
  clusterWindowMs?: number;
  maxEvents?: number;
};

const DEFAULT_CLUSTER_WINDOW_MS = 80;
const DEFAULT_MAX_EVENTS = 8;
const MIN_FINGERPRINT_CLUSTER_CORRELATION = 0.55;
const MAX_FINGERPRINT_CLUSTER_EXTENSION_MS = 320;

export function deriveReconciledAudioEvents(
  devices: AudioEventDevice[],
  {
    clusterWindowMs = DEFAULT_CLUSTER_WINDOW_MS,
    maxEvents = DEFAULT_MAX_EVENTS,
  }: AudioEventReconciliationOptions = {},
): ReconciledAudioEvent[] {
  const observations = devices
    .flatMap((device) =>
      uniqueVoiceEvents(device).map((event) => ({ deviceId: device.deviceId, event })),
    )
    .filter(({ event }) => event.confidence > 0)
    .sort(
      (a, b) =>
        a.event.detectedAtHostEpochMs - b.event.detectedAtHostEpochMs ||
        a.deviceId.localeCompare(b.deviceId),
    );

  const clusters: Array<typeof observations> = [];
  for (const observation of observations) {
    const current = clusters[clusters.length - 1];
    if (!current || !belongsToCluster(observation, current, clusterWindowMs)) {
      clusters.push([observation]);
    } else {
      current.push(observation);
    }
  }

  return clusters.map(reconcileCluster).slice(-maxEvents);
}

function belongsToCluster(
  observation: { deviceId: string; event: VoiceActivityEvent },
  cluster: Array<{ deviceId: string; event: VoiceActivityEvent }>,
  clusterWindowMs: number,
) {
  if (
    observation.event.detectedAtHostEpochMs -
      cluster[0].event.detectedAtHostEpochMs <=
    clusterWindowMs
  ) {
    return true;
  }

  return cluster.some((candidate) =>
    canFingerprintBridgeCluster(candidate.event, observation.event, clusterWindowMs),
  );
}

function canFingerprintBridgeCluster(
  reference: VoiceActivityEvent,
  candidate: VoiceActivityEvent,
  clusterWindowMs: number,
) {
  const offset = estimateFingerprintOffset(
    reference.audioFingerprint,
    candidate.audioFingerprint,
    {
      maxLagBins: 16,
      maxAlignmentLagBins: 32,
    },
  );
  if (!offset || offset.correlation < MIN_FINGERPRINT_CLUSTER_CORRELATION) {
    return false;
  }

  const rawDeltaMs = Math.abs(
    candidate.detectedAtHostEpochMs - reference.detectedAtHostEpochMs,
  );
  const plausibleWindowMs =
    clusterWindowMs +
    Math.min(
      MAX_FINGERPRINT_CLUSTER_EXTENSION_MS,
      clockErrorWindowMs(reference) + clockErrorWindowMs(candidate),
    );

  return rawDeltaMs <= plausibleWindowMs && Math.abs(offset.offsetMs) <= clusterWindowMs;
}

function clockErrorWindowMs(event: VoiceActivityEvent) {
  return Math.max(
    0,
    event.clockUncertaintyMs,
    event.clockMaxErrorMs ?? 0,
  );
}

function reconcileCluster(
  cluster: Array<{ deviceId: string; event: VoiceActivityEvent }>,
): ReconciledAudioEvent {
  const rawObservations = cluster
    .map(({ deviceId, event }) => ({
      deviceId,
      eventId: event.id,
      detectedAtHostEpochMs: event.detectedAtHostEpochMs,
      sampleIndex: event.sampleIndex,
      sampleRate: event.sampleRate,
      audioLevel: event.audioLevel,
      confidence: event.confidence,
      clockUncertaintyMs: event.clockUncertaintyMs,
      clockQuality: event.clockQuality ?? null,
      clockMaxErrorMs: event.clockMaxErrorMs ?? null,
      clockBestRoundTripMs: event.clockBestRoundTripMs ?? null,
      clockJitterMs: event.clockJitterMs ?? null,
      clockSamplesUsed: event.clockSamplesUsed ?? null,
      clockOutliersRejected: event.clockOutliersRejected ?? null,
      clockOffsetStabilityMs: event.clockOffsetStabilityMs ?? null,
      timingConfidence: event.timingConfidence ?? null,
      motionStability: event.motionStability ?? null,
      audioFingerprint: event.audioFingerprint ?? null,
      fingerprintOffsetMs: null,
      fingerprintCorrelation: null,
      refinedDetectedAtHostEpochMs: null,
    }))
    .sort(
      (a, b) =>
        a.detectedAtHostEpochMs - b.detectedAtHostEpochMs ||
        a.deviceId.localeCompare(b.deviceId),
    );
  const observations = alignObservationsWithFingerprints(rawObservations).sort(
    (a, b) =>
      observationHostTime(a) - observationHostTime(b) ||
      a.deviceId.localeCompare(b.deviceId),
  );
  const startedAtHostEpochMs = observationHostTime(observations[0]);
  const endedAtHostEpochMs = observationHostTime(
    observations[observations.length - 1],
  );
  const timeSpreadMs = round(endedAtHostEpochMs - startedAtHostEpochMs);
  const meanTimeMs = round(
    observations.reduce(
      (total, observation) => total + observationHostTime(observation),
      0,
    ) / observations.length,
  );
  const meanConfidence =
    observations.reduce((total, observation) => total + observation.confidence, 0) /
    observations.length;
  const meanUncertaintyMs =
    observations.reduce(
      (total, observation) => total + observation.clockUncertaintyMs,
      0,
    ) / observations.length;
  const timestampUncertaintyMs = Math.max(
    ...observations.map((observation) => observation.clockUncertaintyMs),
  );
  const meanTimingConfidence =
    observations.reduce(
      (total, observation) =>
        total + observationTimingConfidence(observation),
      0,
    ) / observations.length;
  const timingScore = 1 / (1 + (timeSpreadMs + meanUncertaintyMs) / 160);
  const timingQualityScore = 0.65 + meanTimingConfidence * 0.35;
  const fingerprintAlignmentConfidence = meanFingerprintCorrelation(observations);

  return {
    id: `voice:${Math.round(startedAtHostEpochMs)}:${observations[0].eventId}`,
    startedAtHostEpochMs,
    endedAtHostEpochMs,
    centerHostEpochMs: meanTimeMs,
    timeSpreadMs,
    arrivalLeaderDeviceId: observations[0].deviceId,
    observedDeviceIds: observations.map((observation) => observation.deviceId),
    observations,
    timestampUncertaintyMs: round(timestampUncertaintyMs),
    timingConfidence: round(meanTimingConfidence * timingScore),
    fingerprintAlignmentConfidence,
    confidence: round(
      Math.max(0, Math.min(1, meanConfidence * timingScore * timingQualityScore)),
    ),
  };
}

function alignObservationsWithFingerprints(
  observations: ReconciledAudioEventObservation[],
): ReconciledAudioEventObservation[] {
  const reference = observations.find(
    (observation) => observation.audioFingerprint,
  );
  if (!reference?.audioFingerprint) {
    return observations;
  }

  return observations.map((observation) => {
    if (!observation.audioFingerprint) {
      return observation;
    }
    if (observation === reference) {
      return {
        ...observation,
        fingerprintOffsetMs: 0,
        fingerprintCorrelation: 1,
        refinedDetectedAtHostEpochMs: observation.detectedAtHostEpochMs,
      };
    }

    const offset = estimateFingerprintOffset(
      reference.audioFingerprint,
      observation.audioFingerprint,
    );
    if (!offset || offset.correlation < 0.45) {
      return observation;
    }

    return {
      ...observation,
      fingerprintOffsetMs: offset.offsetMs,
      fingerprintCorrelation: offset.correlation,
      refinedDetectedAtHostEpochMs: round(
        reference.detectedAtHostEpochMs + offset.offsetMs,
      ),
    };
  });
}

function observationHostTime(observation: ReconciledAudioEventObservation) {
  return (
    observation.refinedDetectedAtHostEpochMs ??
    observation.detectedAtHostEpochMs
  );
}

function meanFingerprintCorrelation(
  observations: ReconciledAudioEventObservation[],
) {
  const correlations = observations
    .map((observation) => observation.fingerprintCorrelation)
    .filter(
      (correlation): correlation is number =>
        typeof correlation === "number" && Number.isFinite(correlation),
    );
  if (correlations.length <= 1) {
    return null;
  }

  return round(
    correlations.reduce((total, correlation) => total + correlation, 0) /
      correlations.length,
  );
}

function observationTimingConfidence(
  observation: ReconciledAudioEventObservation,
) {
  if (
    typeof observation.timingConfidence === "number" &&
    Number.isFinite(observation.timingConfidence)
  ) {
    return Math.max(0, Math.min(1, observation.timingConfidence));
  }

  if (
    typeof observation.clockQuality === "number" &&
    Number.isFinite(observation.clockQuality)
  ) {
    return Math.max(0, Math.min(1, observation.clockQuality));
  }

  return 1 / (1 + Math.max(0, observation.clockUncertaintyMs) / 24);
}

function uniqueVoiceEvents(device: AudioEventDevice) {
  const deduped = new Map<string, VoiceActivityEvent>();
  for (const event of [...(device.voiceEvents ?? []), device.voiceEvent]) {
    if (!event) {
      continue;
    }
    deduped.delete(event.id);
    deduped.set(event.id, event);
  }
  return [...deduped.values()];
}

function round(value: number) {
  return Number(value.toFixed(3));
}
