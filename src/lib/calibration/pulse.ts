import type {
  AcousticObservation,
  AcousticPulse,
} from "@/lib/session/registry";
import {
  detectPulse,
  synthesizePulseTemplate,
  synthesizeQuadraturePulseTemplate,
  type PulseDetectionOptions,
} from "../acoustics/pulse-detector";
import {
  audioSampleTimestamp,
} from "../timing/clock-sync";

const DEFAULT_LEAD_MS = 2_200;
// Phone speakers and mics roll off steeply above ~17 kHz; a 17.2-19.2 kHz
// sweep arrives at the matched filter with almost no energy at arm's length.
// Start the sweep at 16.5 kHz (still near-inaudible to most adults) and run
// it longer: correlation gain scales with duration x bandwidth, and 80 ms at
// 2.5 kHz of sweep is detectable across a room on real phone transducers.
const DEFAULT_DURATION_MS = 80;
const DEFAULT_FREQUENCY_HZ = 16_500;
const DEFAULT_END_FREQUENCY_HZ = 19_000;
const MIN_OBSERVATION_LEVEL = 0.012;
const MAX_PROPAGATION_MS = 45;

export type ScheduledPulseInput = {
  deviceId: string;
  sequence: number;
  hostEpochNowMs: number;
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

export type SampledToneObservationInput = {
  pulse: AcousticPulse;
  detectedSampleIndex: number;
  sampleRate: number;
  anchorAudioContextTimeSeconds: number;
  anchorPerformanceNowMs: number;
  clientPerfOriginEpochMs: number;
  clockOffsetMs: number;
  clockUncertaintyMs: number;
  amplitude: number;
  detectionConfidence: number;
};

export function createScheduledAcousticPulse({
  deviceId,
  sequence,
  hostEpochNowMs,
  leadMs = DEFAULT_LEAD_MS,
  durationMs = DEFAULT_DURATION_MS,
  frequencyHz = DEFAULT_FREQUENCY_HZ,
  endFrequencyHz = DEFAULT_END_FREQUENCY_HZ,
}: ScheduledPulseInput): AcousticPulse {
  const emittedAtHostEpochMs = Math.round(hostEpochNowMs + leadMs);

  return {
    id: `${deviceId}:${sequence}:${emittedAtHostEpochMs}`,
    emittedAtHostEpochMs,
    durationMs,
    frequencyHz,
    endFrequencyHz,
  };
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
  const templateOptions = {
    frequencyHz: pulse.frequencyHz,
    endFrequencyHz: pulse.endFrequencyHz ?? undefined,
    durationMs: pulse.durationMs,
    sampleRate: audioWindow.sampleRate,
  };
  const template = synthesizePulseTemplate(templateOptions);
  const detection = detectPulse(audioWindow.samples, template, {
    quadratureTemplate: synthesizeQuadraturePulseTemplate(templateOptions),
    ...detectionOptions,
  });
  if (!detection) {
    return null;
  }

  const detectedSampleIndex =
    audioWindow.startSampleIndex + detection.refinedStartSample;
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

export function createSampledToneObservation({
  pulse,
  detectedSampleIndex,
  sampleRate,
  anchorAudioContextTimeSeconds,
  anchorPerformanceNowMs,
  clientPerfOriginEpochMs,
  clockOffsetMs,
  clockUncertaintyMs,
  amplitude,
  detectionConfidence,
}: SampledToneObservationInput): AcousticObservation | null {
  if (
    !Number.isFinite(detectedSampleIndex) ||
    detectedSampleIndex < 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return null;
  }

  const timestamp = audioSampleTimestamp({
    sampleIndex: detectedSampleIndex,
    sampleRate,
    anchorAudioContextTimeSeconds,
    anchorPerformanceNowMs,
    clientPerfOriginEpochMs,
    clockOffsetMs,
    clockUncertaintyMs,
  });

  return {
    pulseId: pulse.id,
    detectedAtHostEpochMs: timestamp.hostEstimatedEpochMs,
    detectedSampleIndex,
    sampleRate,
    amplitude: round(Math.min(1, Math.max(0, amplitude)), 3),
    confidence: round(
      observationConfidence(amplitude, clockUncertaintyMs) *
        Math.max(0, Math.min(1, detectionConfidence)),
      3,
    ),
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
