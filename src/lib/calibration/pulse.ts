import type {
  AcousticObservation,
  AcousticPulse,
} from "@/lib/session/registry";

const DEFAULT_LEAD_MS = 2_200;
const DEFAULT_DURATION_MS = 48;
const DEFAULT_FREQUENCY_HZ = 18_500;
const MIN_OBSERVATION_LEVEL = 0.012;
const MAX_PROPAGATION_MS = 45;

export type ScheduledPulseInput = {
  deviceId: string;
  sequence: number;
  hostEpochNowMs: number;
  leadMs?: number;
  durationMs?: number;
  frequencyHz?: number;
};

export type ToneObservationInput = {
  pulse: AcousticPulse;
  detectedAtHostEpochMs: number;
  micLevel: number;
  clockUncertaintyMs: number;
};

export function createScheduledAcousticPulse({
  deviceId,
  sequence,
  hostEpochNowMs,
  leadMs = DEFAULT_LEAD_MS,
  durationMs = DEFAULT_DURATION_MS,
  frequencyHz = DEFAULT_FREQUENCY_HZ,
}: ScheduledPulseInput): AcousticPulse {
  const emittedAtHostEpochMs = Math.round(hostEpochNowMs + leadMs);

  return {
    id: `${deviceId}:${sequence}:${emittedAtHostEpochMs}`,
    emittedAtHostEpochMs,
    durationMs,
    frequencyHz,
  };
}

export function createToneObservation({
  pulse,
  detectedAtHostEpochMs,
  micLevel,
  clockUncertaintyMs,
}: ToneObservationInput): AcousticObservation | null {
  const propagationMs = detectedAtHostEpochMs - pulse.emittedAtHostEpochMs;
  if (
    micLevel < MIN_OBSERVATION_LEVEL ||
    propagationMs <= 0 ||
    propagationMs > MAX_PROPAGATION_MS
  ) {
    return null;
  }

  return {
    pulseId: pulse.id,
    detectedAtHostEpochMs,
    amplitude: round(Math.min(1, Math.max(0, micLevel)), 3),
    confidence: observationConfidence(micLevel, clockUncertaintyMs),
    clockUncertaintyMs,
  };
}

function observationConfidence(micLevel: number, clockUncertaintyMs: number) {
  const levelScore = Math.min(1, micLevel / 0.12);
  const timingScore = 1 / (1 + Math.max(0, clockUncertaintyMs) / 18);
  return round(Math.max(0, Math.min(1, levelScore * timingScore)), 3);
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
