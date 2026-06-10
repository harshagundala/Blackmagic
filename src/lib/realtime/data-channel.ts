import type {
  RealtimeClockProbeMessage,
  RealtimeDataChannelMessage,
  RealtimeSensorFrameMessage,
} from "./contracts";
import type { AcousticObservation } from "../session/registry";

const DATA_CHANNEL_MESSAGE_VERSION = 1;
const MAX_DATA_CHANNEL_MESSAGE_CHARS = 64_000;

export type RealtimeSensorFrameInput = {
  deviceId: string;
  sequence: number;
  sentAtClientPerfMs: number;
  snapshot: {
    micLevel?: number | null;
    sampleRate?: number | null;
    audioFrame?: {
      sampleIndex?: number | null;
      sampleRate?: number | null;
      hostEstimatedEpochMs?: number | null;
      clockUncertaintyMs?: number | null;
      timingConfidence?: number | null;
    } | null;
    pulseObservation?: AcousticObservation | null;
    clock?: {
      offsetMs?: number | null;
      uncertaintyMs?: number | null;
      quality?: number | null;
      maxErrorMs?: number | null;
      bestRoundTripMs?: number | null;
      jitterMs?: number | null;
      samplesUsed?: number | null;
      offsetStabilityMs?: number | null;
      referencePerfMs?: number | null;
      updatedAtClientPerfMs?: number | null;
    } | null;
    headingDegrees?: number | null;
    motionStability?: number | null;
    motionRotationRateDegPerSec?: number | null;
    motionCapturedAtClientPerfMs?: number | null;
  };
};

export function createClockProbeMessage({
  id,
  fromDeviceId,
  sentAtClientPerfMs,
  hostEstimatedEpochMs,
}: {
  id: string;
  fromDeviceId: string;
  sentAtClientPerfMs: number;
  hostEstimatedEpochMs?: number | null;
}): RealtimeClockProbeMessage {
  return {
    type: "clock-probe",
    version: DATA_CHANNEL_MESSAGE_VERSION,
    id,
    fromDeviceId,
    sentAtClientPerfMs,
    hostEstimatedEpochMs: finiteNumberOrNull(hostEstimatedEpochMs),
  };
}

export function createRealtimeSensorFrame({
  deviceId,
  sequence,
  sentAtClientPerfMs,
  snapshot,
}: RealtimeSensorFrameInput): RealtimeSensorFrameMessage {
  const audioFrame = snapshot.audioFrame;
  const clock = snapshot.clock;
  const audioSampleIndex = finiteNumberOrNull(audioFrame?.sampleIndex);
  const audioSampleRate = finiteNumberOrNull(audioFrame?.sampleRate);
  const audioHostEpochMs = finiteNumberOrNull(
    audioFrame?.hostEstimatedEpochMs,
  );

  return {
    type: "sensor-frame",
    version: DATA_CHANNEL_MESSAGE_VERSION,
    fromDeviceId: deviceId,
    sequence,
    sentAtClientPerfMs,
    hostEstimatedEpochMs: audioHostEpochMs,
    micLevel: clamp(finiteNumberOrNull(snapshot.micLevel) ?? 0, 0, 1),
    sampleRate: finiteNumberOrNull(snapshot.sampleRate),
    headingDegrees: finiteNumberOrNull(snapshot.headingDegrees),
    motionStability: finiteNumberOrNull(snapshot.motionStability),
    motionRotationRateDegPerSec: finiteNumberOrNull(
      snapshot.motionRotationRateDegPerSec,
    ),
    motionCapturedAtClientPerfMs: finiteNumberOrNull(
      snapshot.motionCapturedAtClientPerfMs,
    ),
    clock: clock
      ? {
          offsetMs: finiteNumberOrNull(clock.offsetMs),
          uncertaintyMs: finiteNumberOrNull(clock.uncertaintyMs),
          quality: finiteNumberOrNull(clock.quality),
          maxErrorMs: finiteNumberOrNull(clock.maxErrorMs),
          bestRoundTripMs: finiteNumberOrNull(clock.bestRoundTripMs),
          jitterMs: finiteNumberOrNull(clock.jitterMs),
          samplesUsed: finiteNumberOrNull(clock.samplesUsed),
          offsetStabilityMs: finiteNumberOrNull(clock.offsetStabilityMs),
          updatedAtClientPerfMs: finiteNumberOrNull(
            clock.updatedAtClientPerfMs ?? clock.referencePerfMs,
          ),
        }
      : null,
    audioFrame:
      audioSampleIndex !== null &&
      audioSampleRate !== null &&
      audioHostEpochMs !== null
        ? {
            sampleIndex: audioSampleIndex,
            sampleRate: audioSampleRate,
            hostEstimatedEpochMs: audioHostEpochMs,
            clockUncertaintyMs: finiteNumberOrNull(
              audioFrame?.clockUncertaintyMs,
            ),
            timingConfidence: finiteNumberOrNull(
              audioFrame?.timingConfidence,
            ),
          }
        : null,
    pulseObservation: snapshot.pulseObservation ?? null,
  };
}

export function serializeRealtimeDataChannelMessage(
  message: RealtimeDataChannelMessage,
) {
  return JSON.stringify(message);
}

export function parseRealtimeDataChannelMessage(
  raw: string,
): RealtimeDataChannelMessage | null {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_DATA_CHANNEL_MESSAGE_CHARS
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isRealtimeDataChannelMessage(parsed) ? parsed : null;
}

export function isRealtimeDataChannelMessage(
  value: unknown,
): value is RealtimeDataChannelMessage {
  if (!isRecord(value) || value.version !== DATA_CHANNEL_MESSAGE_VERSION) {
    return false;
  }

  switch (value.type) {
    case "clock-probe":
      return (
        nonEmptyString(value.id) &&
        nonEmptyString(value.fromDeviceId) &&
        finiteNumber(value.sentAtClientPerfMs) &&
        nullableFiniteNumber(value.hostEstimatedEpochMs)
      );
    case "clock-probe-ack":
      return (
        nonEmptyString(value.id) &&
        nonEmptyString(value.fromDeviceId) &&
        finiteNumber(value.probeSentAtClientPerfMs) &&
        finiteNumber(value.probeReceivedAtClientPerfMs) &&
        finiteNumber(value.ackSentAtClientPerfMs) &&
        nullableFiniteNumber(value.hostEstimatedEpochMs)
      );
    case "sensor-frame":
      return (
        nonEmptyString(value.fromDeviceId) &&
        finiteNumber(value.sequence) &&
        finiteNumber(value.sentAtClientPerfMs) &&
        nullableFiniteNumber(value.hostEstimatedEpochMs) &&
        finiteNumber(value.micLevel)
      );
    case "chirp-schedule":
      return nonEmptyString(value.fromDeviceId) && isRecord(value.pulse);
    case "pulse-observation":
      return nonEmptyString(value.fromDeviceId) && isRecord(value.observation);
    default:
      return false;
  }
}

function finiteNumberOrNull(value: unknown) {
  return finiteNumber(value) ? value : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableFiniteNumber(value: unknown) {
  return value === null || finiteNumber(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
