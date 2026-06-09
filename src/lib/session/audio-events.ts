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
  confidence: number;
};

export type AudioEventReconciliationOptions = {
  clusterWindowMs?: number;
  maxEvents?: number;
};

const DEFAULT_CLUSTER_WINDOW_MS = 80;
const DEFAULT_MAX_EVENTS = 8;

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
    if (
      !current ||
      observation.event.detectedAtHostEpochMs -
        current[0].event.detectedAtHostEpochMs >
        clusterWindowMs
    ) {
      clusters.push([observation]);
    } else {
      current.push(observation);
    }
  }

  return clusters.map(reconcileCluster).slice(-maxEvents);
}

function reconcileCluster(
  cluster: Array<{ deviceId: string; event: VoiceActivityEvent }>,
): ReconciledAudioEvent {
  const observations = cluster
    .map(({ deviceId, event }) => ({
      deviceId,
      eventId: event.id,
      detectedAtHostEpochMs: event.detectedAtHostEpochMs,
      sampleIndex: event.sampleIndex,
      sampleRate: event.sampleRate,
      audioLevel: event.audioLevel,
      confidence: event.confidence,
      clockUncertaintyMs: event.clockUncertaintyMs,
    }))
    .sort(
      (a, b) =>
        a.detectedAtHostEpochMs - b.detectedAtHostEpochMs ||
        a.deviceId.localeCompare(b.deviceId),
    );
  const startedAtHostEpochMs = observations[0].detectedAtHostEpochMs;
  const endedAtHostEpochMs =
    observations[observations.length - 1].detectedAtHostEpochMs;
  const timeSpreadMs = round(endedAtHostEpochMs - startedAtHostEpochMs);
  const meanTimeMs = round(
    observations.reduce(
      (total, observation) => total + observation.detectedAtHostEpochMs,
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
  const timingScore = 1 / (1 + (timeSpreadMs + meanUncertaintyMs) / 160);

  return {
    id: `voice:${Math.round(startedAtHostEpochMs)}:${observations[0].eventId}`,
    startedAtHostEpochMs,
    endedAtHostEpochMs,
    centerHostEpochMs: meanTimeMs,
    timeSpreadMs,
    arrivalLeaderDeviceId: observations[0].deviceId,
    observedDeviceIds: observations.map((observation) => observation.deviceId),
    observations,
    confidence: round(Math.max(0, Math.min(1, meanConfidence * timingScore))),
  };
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
