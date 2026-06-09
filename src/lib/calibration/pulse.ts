import type {
  AcousticObservation,
  AcousticPulse,
} from "@/lib/session/registry";
import {
  detectPulse,
  synthesizePulseTemplate,
  type PulseDetectionOptions,
} from "../acoustics/pulse-detector";
import {
  audioSampleTimestamp,
  type AudioFrameTimestamp,
} from "../timing/clock-sync";

const DEFAULT_LEAD_MS = 2_200;
const DEFAULT_DURATION_MS = 48;
const DEFAULT_FREQUENCY_HZ = 17_200;
const DEFAULT_END_FREQUENCY_HZ = 19_200;
const MIN_OBSERVATION_LEVEL = 0.012;
const MAX_PROPAGATION_MS = 45;

export type ScheduledPulseInput = {
  deviceId: string;
  sequence: number;
  hostEpochNowMs: number;
  audioFrame?: Pick<
    AudioFrameTimestamp,
    "sampleIndex" | "sampleRate" | "hostEstimatedEpochMs"
  > | null;
  leadMs?: number;
  durationMs?: number;
  frequencyHz?: number;
  endFrequencyHz?: number;
};

export type ToneObservationInput = {
  pulse: AcousticPulse;
  detectedAtHostEpochMs: number;
  micLevel: number;
  clockUncertaintyMs: number;
  confidenceScale?: number;
};

export type AudioPulseWindow = {
  samples: Float32Array;
  sampleRate: number;
  startSampleIndex: number;
  anchorAudioContextTimeSeconds: number;
  anchorPerformanceNowMs: number;
  clientPerfOriginEpochMs: number;
  clockOffsetMs: number;
  clockUncertaintyMs: number;
};

export type MatchedToneObservationInput = {
  pulse: AcousticPulse;
  audioWindow: AudioPulseWindow;
} & PulseDetectionOptions;

export function createScheduledAcousticPulse({
  deviceId,
  sequence,
  hostEpochNowMs,
  audioFrame,
  leadMs = DEFAULT_LEAD_MS,
  durationMs = DEFAULT_DURATION_MS,
  frequencyHz = DEFAULT_FREQUENCY_HZ,
  endFrequencyHz = DEFAULT_END_FREQUENCY_HZ,
}: ScheduledPulseInput): AcousticPulse {
  const emittedAtHostEpochMs = Math.round(hostEpochNowMs + leadMs);
  const emittedSampleIndex = estimatedSampleIndexForHostEpoch(
    emittedAtHostEpochMs,
    audioFrame,
  );

  const pulse: AcousticPulse = {
    id: `${deviceId}:${sequence}:${emittedAtHostEpochMs}`,
    emittedAtHostEpochMs,
    durationMs,
    frequencyHz,
    endFrequencyHz,
  };

  if (emittedSampleIndex !== null && audioFrame) {
    return {
      ...pulse,
      emittedSampleIndex,
      sampleRate: audioFrame.sampleRate,
    };
  }

  return pulse;
}

export function createToneObservation({
  pulse,
  detectedAtHostEpochMs,
  micLevel,
  clockUncertaintyMs,
  confidenceScale = 1,
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
    confidence: round(
      observationConfidence(micLevel, clockUncertaintyMs) *
        Math.max(0, Math.min(1, confidenceScale)),
      3,
    ),
    clockUncertaintyMs,
  };
}

export function createMatchedToneObservation({
  pulse,
  audioWindow,
  ...detectionOptions
}: MatchedToneObservationInput): AcousticObservation | null {
  const template = synthesizePulseTemplate({
    frequencyHz: pulse.frequencyHz,
    endFrequencyHz: pulse.endFrequencyHz ?? undefined,
    durationMs: pulse.durationMs,
    sampleRate: audioWindow.sampleRate,
  });
  const detection = detectPulse(audioWindow.samples, template, detectionOptions);
  if (!detection) {
    return null;
  }

  const detectedSampleIndex =
    audioWindow.startSampleIndex + detection.startSample;
  const timestamp = audioSampleTimestamp({
    sampleIndex: detectedSampleIndex,
    sampleRate: audioWindow.sampleRate,
    anchorAudioContextTimeSeconds: audioWindow.anchorAudioContextTimeSeconds,
    anchorPerformanceNowMs: audioWindow.anchorPerformanceNowMs,
    clientPerfOriginEpochMs: audioWindow.clientPerfOriginEpochMs,
    clockOffsetMs: audioWindow.clockOffsetMs,
    clockUncertaintyMs: audioWindow.clockUncertaintyMs,
  });

  return {
    pulseId: pulse.id,
    detectedAtHostEpochMs: timestamp.hostEstimatedEpochMs,
    detectedSampleIndex,
    sampleRate: audioWindow.sampleRate,
    amplitude: round(Math.min(1, Math.max(0, detection.amplitude)), 3),
    confidence: round(
      observationConfidence(detection.amplitude, audioWindow.clockUncertaintyMs) *
        Math.max(0, Math.min(1, detection.confidence)),
      3,
    ),
    clockUncertaintyMs: audioWindow.clockUncertaintyMs,
  };
}

function estimatedSampleIndexForHostEpoch(
  hostEpochMs: number,
  audioFrame:
    | Pick<
        AudioFrameTimestamp,
        "sampleIndex" | "sampleRate" | "hostEstimatedEpochMs"
      >
    | null
    | undefined,
) {
  if (
    !audioFrame ||
    !Number.isFinite(hostEpochMs) ||
    !Number.isFinite(audioFrame.sampleIndex) ||
    !Number.isFinite(audioFrame.sampleRate) ||
    audioFrame.sampleRate <= 0 ||
    !Number.isFinite(audioFrame.hostEstimatedEpochMs)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.round(
      audioFrame.sampleIndex +
        ((hostEpochMs - audioFrame.hostEstimatedEpochMs) / 1_000) *
          audioFrame.sampleRate,
    ),
  );
}

function observationConfidence(micLevel: number, clockUncertaintyMs: number) {
  const levelScore = Math.min(1, micLevel / 0.12);
  const timingScore = 1 / (1 + Math.max(0, clockUncertaintyMs) / 18);
  return round(Math.max(0, Math.min(1, levelScore * timingScore)), 3);
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
