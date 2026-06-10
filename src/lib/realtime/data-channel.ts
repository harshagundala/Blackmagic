import type {
  RealtimeClockProbeAckMessage,
  RealtimeClockProbeMessage,
  RealtimeDataChannelMessage,
  RealtimeSensorFrameMessage,
} from "./contracts";
import type { AcousticObservation } from "../session/registry";
import type { ClockExchange } from "../timing/clock-sync";

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

export function createClockProbeAckMessage({
  probe,
  fromDeviceId,
  probeReceivedAtClientPerfMs,
  ackSentAtClientPerfMs,
  perfOriginEpochMs,
  hostEstimatedEpochMs,
}: {
  probe: RealtimeClockProbeMessage;
  fromDeviceId: string;
  probeReceivedAtClientPerfMs: number;
  ackSentAtClientPerfMs: number;
  // The responder's performance.timeOrigin equivalent; lets the prober map
  // the responder's perf instants into the responder's wall-clock domain.
  perfOriginEpochMs: number;
  hostEstimatedEpochMs?: number | null;
}): RealtimeClockProbeAckMessage {
  return {
    type: "clock-probe-ack",
    version: DATA_CHANNEL_MESSAGE_VERSION,
    id: probe.id,
    fromDeviceId,
    probeSentAtClientPerfMs: probe.sentAtClientPerfMs,
    probeReceivedAtClientPerfMs,
    ackSentAtClientPerfMs,
    hostEstimatedEpochMs: finiteNumberOrNull(hostEstimatedEpochMs),
    probeReceivedAtEpochMs: finiteNumberOrNull(
      perfOriginEpochMs + probeReceivedAtClientPerfMs,
    ),
    ackSentAtEpochMs: finiteNumberOrNull(
      perfOriginEpochMs + ackSentAtClientPerfMs,
    ),
  };
}

// Converts a completed probe/ack round trip into the same ClockExchange shape
// the HTTP time-echo path produces, so the existing robust clock model can
// consume data-channel exchanges unchanged. The "server" side of the exchange
// is the responding peer (normally the room host).
export function clockExchangeFromProbeAck({
  ack,
  receivedAtClientPerfMs,
  clientPerfOriginEpochMs,
}: {
  ack: RealtimeClockProbeAckMessage;
  receivedAtClientPerfMs: number;
  clientPerfOriginEpochMs: number;
}): ClockExchange | null {
  const probeReceivedAtEpochMs = finiteNumberOrNull(ack.probeReceivedAtEpochMs);
  const ackSentAtEpochMs = finiteNumberOrNull(ack.ackSentAtEpochMs);
  if (
    probeReceivedAtEpochMs === null ||
    ackSentAtEpochMs === null ||
    !finiteNumber(ack.probeSentAtClientPerfMs) ||
    !finiteNumber(receivedAtClientPerfMs) ||
    receivedAtClientPerfMs <= ack.probeSentAtClientPerfMs ||
    ackSentAtEpochMs < probeReceivedAtEpochMs
  ) {
    return null;
  }

  return {
    clientPerfOriginEpochMs,
    clientSendPerfMs: ack.probeSentAtClientPerfMs,
    serverReceiveEpochMs: probeReceivedAtEpochMs,
    serverSendEpochMs: ackSentAtEpochMs,
    clientReceivePerfMs: receivedAtClientPerfMs,
    serverInstanceId: `peer:${ack.fromDeviceId}`,
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
        nullableFiniteNumber(value.hostEstimatedEpochMs) &&
        optionalNullableFiniteNumber(value.probeReceivedAtEpochMs) &&
        optionalNullableFiniteNumber(value.ackSentAtEpochMs)
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

function optionalNullableFiniteNumber(value: unknown) {
  return value === undefined || nullableFiniteNumber(value);
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
