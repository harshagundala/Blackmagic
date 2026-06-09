import type { RoomDevice } from "./registry";

export type AcousticRange = {
  from: string;
  to: string;
  pulseId: string;
  meters: number;
  confidence: number;
  observedAtHostEpochMs: number;
};

const SPEED_OF_SOUND_METERS_PER_SECOND = 343;
const MAX_SAME_ROOM_PROPAGATION_MS = 45;

export function deriveAcousticRanges(devices: RoomDevice[]): AcousticRange[] {
  const pulses = devices
    .filter((device) => device.acousticPulse)
    .map((device) => ({
      device,
      pulse: device.acousticPulse!,
    }));

  if (pulses.length === 0) {
    return [];
  }

  const ranges: AcousticRange[] = [];

  for (const observer of devices) {
    const observation = observer.acousticObservation;
    if (!observation) {
      continue;
    }

    const emitter = pulses.find(({ pulse }) => pulse.id === observation.pulseId);
    if (!emitter || emitter.device.deviceId === observer.deviceId) {
      continue;
    }

    const propagationMs =
      observation.detectedAtHostEpochMs -
      emitter.pulse.emittedAtHostEpochMs;
    if (
      propagationMs <= 0 ||
      propagationMs > MAX_SAME_ROOM_PROPAGATION_MS
    ) {
      continue;
    }

    const meters = (propagationMs / 1_000) * SPEED_OF_SOUND_METERS_PER_SECOND;
    ranges.push({
      from: emitter.device.deviceId,
      to: observer.deviceId,
      pulseId: emitter.pulse.id,
      meters: round(meters, 2),
      confidence: rangeConfidence(
        observation.confidence,
        observation.amplitude,
        observation.clockUncertaintyMs ?? 0,
      ),
      observedAtHostEpochMs: observation.detectedAtHostEpochMs,
    });
  }

  return ranges.sort((a, b) =>
    `${a.from}:${a.to}:${a.pulseId}`.localeCompare(
      `${b.from}:${b.to}:${b.pulseId}`,
    ),
  );
}

function rangeConfidence(
  observationConfidence: number,
  amplitude: number,
  clockUncertaintyMs: number,
) {
  const amplitudeScore = Math.min(1, Math.max(0, amplitude) / 0.35);
  const timingScore = 1 / (1 + Math.max(0, clockUncertaintyMs) / 12);
  return round(
    Math.max(0, Math.min(1, observationConfidence * amplitudeScore * timingScore)),
    3,
  );
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
