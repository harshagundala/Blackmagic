import type { AcousticObservation } from "@/lib/session/registry";

const AMPLITUDE_REPLACEMENT_GAIN = 1.35;
const CONFIDENCE_REPLACEMENT_GAIN = 0.12;

export function shouldPublishAcousticObservation(
  previous: AcousticObservation | null | undefined,
  next: AcousticObservation | null | undefined,
) {
  if (!next) {
    return false;
  }

  if (!previous || previous.pulseId !== next.pulseId) {
    return true;
  }

  const previousSampleAnchor = sampleAnchor(previous);
  const nextSampleAnchor = sampleAnchor(next);
  if (!nextSampleAnchor) {
    return false;
  }

  if (!previousSampleAnchor) {
    return true;
  }

  if (previousSampleAnchor.sampleIndex === nextSampleAnchor.sampleIndex) {
    return false;
  }

  const amplitudeGain = next.amplitude / Math.max(0.001, previous.amplitude);
  const confidenceGain = next.confidence - previous.confidence;

  return (
    amplitudeGain >= AMPLITUDE_REPLACEMENT_GAIN ||
    confidenceGain >= CONFIDENCE_REPLACEMENT_GAIN
  );
}

export function acousticObservationPublishKey(
  observation: AcousticObservation,
) {
  const anchor = sampleAnchor(observation);
  if (!anchor) {
    return `${observation.pulseId}:timestamp`;
  }

  return `${observation.pulseId}:${Math.round(anchor.sampleRate)}:${
    anchor.sampleIndex
  }`;
}

function sampleAnchor(observation: AcousticObservation) {
  if (
    typeof observation.detectedSampleIndex !== "number" ||
    !Number.isFinite(observation.detectedSampleIndex) ||
    observation.detectedSampleIndex < 0 ||
    typeof observation.sampleRate !== "number" ||
    !Number.isFinite(observation.sampleRate) ||
    observation.sampleRate <= 0
  ) {
    return null;
  }

  return {
    sampleIndex: Math.round(observation.detectedSampleIndex),
    sampleRate: observation.sampleRate,
  };
}
