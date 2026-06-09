import {
  timestampConfidence,
  type AudioFrameTimestamp,
} from "../timing/clock-sync";
import {
  deriveReconciledAudioEvents,
  type ReconciledAudioEvent,
  type VoiceActivityEvent,
} from "./audio-events";
import {
  selectUpcomingCalibrationTurn,
  type LiveCalibrationTurn,
} from "../calibration/session";
import { deriveAcousticRanges, type AcousticRange } from "./ranging";
import {
  deriveRoomTimeSync,
  type RoomTimeSyncState,
} from "./timing-health";

export type SessionRole = "host" | "phone";

export type SessionClaim = {
  deviceId: string;
  joinedAt: number;
  lastSeenAt: number;
  role: SessionRole;
  sessionKey: string;
};

export type SensorState = "idle" | "active" | "blocked";

export type AcousticPulse = {
  id: string;
  emittedAtHostEpochMs: number;
  emittedSampleIndex?: number | null;
  sampleRate?: number | null;
  durationMs: number;
  frequencyHz: number;
  endFrequencyHz?: number | null;
};

export type AcousticObservation = {
  pulseId: string;
  detectedAtHostEpochMs: number;
  detectedSampleIndex?: number | null;
  sampleRate?: number | null;
  amplitude: number;
  confidence: number;
  clockUncertaintyMs?: number | null;
};

export type DeviceHeartbeat = {
  mic?: SensorState;
  micLevel?: number | null;
  sampleRate?: number | null;
  clockQuality?: number | null;
  clockOffsetMs?: number | null;
  clockUncertaintyMs?: number | null;
  clockMaxErrorMs?: number | null;
  clockBestRoundTripMs?: number | null;
  clockJitterMs?: number | null;
  clockSamplesUsed?: number | null;
  clockOutliersRejected?: number | null;
  clockOffsetStabilityMs?: number | null;
  audioFrame?: AudioFrameTimestamp | null;
  acousticPulse?: AcousticPulse | null;
  acousticPulses?: AcousticPulse[] | null;
  acousticObservation?: AcousticObservation | null;
  acousticObservations?: AcousticObservation[] | null;
  voiceEvent?: VoiceActivityEvent | null;
  voiceEvents?: VoiceActivityEvent[] | null;
  motion?: SensorState;
  motionAccelerationX?: number | null;
  motionAccelerationY?: number | null;
  motionAccelerationZ?: number | null;
  motionAccelerationIncludingGravityX?: number | null;
  motionAccelerationIncludingGravityY?: number | null;
  motionAccelerationIncludingGravityZ?: number | null;
  motionAccelerationMagnitude?: number | null;
  motionRotationAlpha?: number | null;
  motionRotationBeta?: number | null;
  motionRotationGamma?: number | null;
  motionRotationRateDegPerSec?: number | null;
  motionIntervalMs?: number | null;
  motionCapturedAtClientPerfMs?: number | null;
  motionStability?: number | null;
  heading?: SensorState;
  headingDegrees?: number | null;
  orientationBetaDegrees?: number | null;
  orientationGammaDegrees?: number | null;
  orientationAbsolute?: boolean | null;
  location?: SensorState;
  locationLatitude?: number | null;
  locationLongitude?: number | null;
  locationAccuracyMeters?: number | null;
  locationAltitudeMeters?: number | null;
  locationAltitudeAccuracyMeters?: number | null;
  locationHeadingDegrees?: number | null;
  locationSpeedMetersPerSecond?: number | null;
  locationCapturedAtEpochMs?: number | null;
};

export type RoomDevice = SessionClaim & DeviceHeartbeat;

export type RoomState = {
  sessionKey: string;
  hostDeviceId: string;
  revision: number;
  changedAt: number;
  devices: RoomDevice[];
  calibrationTurn: LiveCalibrationTurn | null;
  timeSync: RoomTimeSyncState;
  ranges: AcousticRange[];
  audioEvents: ReconciledAudioEvent[];
  updatedAt: number;
};

type SessionRecord = {
  hostDeviceId: string;
  revision: number;
  changedAt: number;
  claims: Map<string, RoomDevice>;
};

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;

export type SessionRegistryOptions = {
  now?: () => number;
  staleAfterMs?: number;
};

export const DEFAULT_STALE_AFTER_MS = 12_000;
const MAX_ACOUSTIC_HISTORY = 8;

export function createSessionRegistry(options: SessionRegistryOptions = {}) {
  const sessions = new Map<string, SessionRecord>();
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return {
    claim(url: string, deviceId: string): SessionClaim {
      const sessionKey = normalizeSessionKey(url);
      const existing = sessions.get(sessionKey);
      const timestamp = now();

      if (!existing) {
        const claim = {
          deviceId,
          joinedAt: timestamp,
          lastSeenAt: timestamp,
          role: "host" as const,
          sessionKey,
        };
        sessions.set(sessionKey, {
          hostDeviceId: deviceId,
          revision: 1,
          changedAt: timestamp,
          claims: new Map([[deviceId, claim]]),
        });
        return claim;
      }

      if (pruneStaleClaims(existing, timestamp, staleAfterMs)) {
        touchRecord(existing, timestamp);
      }

      if (existing.claims.size === 0) {
        const claim = {
          deviceId,
          joinedAt: timestamp,
          lastSeenAt: timestamp,
          role: "host" as const,
          sessionKey,
        };
        existing.hostDeviceId = deviceId;
        existing.claims.set(deviceId, claim);
        touchRecord(existing, timestamp);
        return claim;
      }

      const previous = existing.claims.get(deviceId);
      if (previous) {
        previous.lastSeenAt = timestamp;
        touchRecord(existing, timestamp);
        return previous;
      }

      const claim = {
        deviceId,
        joinedAt: timestamp,
        lastSeenAt: timestamp,
        role: existing.hostDeviceId === deviceId ? ("host" as const) : ("phone" as const),
        sessionKey,
      };
      existing.claims.set(deviceId, claim);
      touchRecord(existing, timestamp);
      return claim;
    },

    heartbeat(
      url: string,
      deviceId: string,
      heartbeat: DeviceHeartbeat = {},
    ): RoomState {
      const claim = this.claim(url, deviceId);
      const record = sessions.get(claim.sessionKey);
      if (!record) {
        throw new Error("Session record missing after claim.");
      }

      const current = record.claims.get(deviceId);
      if (!current) {
        throw new Error("Device claim missing after claim.");
      }

      const timestamp = now();
      Object.assign(current, mergeHeartbeat(current, heartbeat), {
        lastSeenAt: timestamp,
      });
      touchRecord(record, timestamp);

      return this.state(url);
    },

    state(url: string): RoomState {
      const sessionKey = normalizeSessionKey(url);
      const record = sessions.get(sessionKey);
      const timestamp = now();

      if (!record) {
        return {
          sessionKey,
          hostDeviceId: "",
          revision: 0,
          changedAt: 0,
          devices: [],
          calibrationTurn: null,
          timeSync: deriveRoomTimeSync([]),
          ranges: [],
          audioEvents: [],
          updatedAt: timestamp,
        };
      }

      if (pruneStaleClaims(record, timestamp, staleAfterMs)) {
        touchRecord(record, timestamp);
      }
      const devices = [...record.claims.values()].sort(compareDevices);

      return {
        sessionKey,
        hostDeviceId: record.hostDeviceId,
        revision: record.revision,
        changedAt: record.changedAt,
        devices,
        calibrationTurn: selectRoomCalibrationTurn(devices, timestamp),
        timeSync: deriveRoomTimeSync(devices),
        ranges: deriveAcousticRanges(devices, { hostEpochNowMs: timestamp }),
        audioEvents: deriveReconciledAudioEvents(devices),
        updatedAt: timestamp,
      };
    },
  };
}

export function selectRoomCalibrationTurn(
  devices: RoomDevice[],
  hostEpochNowMs: number,
) {
  return selectUpcomingCalibrationTurn(
    devices.map((device) => device.deviceId),
    hostEpochNowMs,
  );
}

function touchRecord(record: SessionRecord, timestamp: number) {
  record.revision += 1;
  record.changedAt = timestamp;
}

function pruneStaleClaims(
  record: SessionRecord,
  timestamp: number,
  staleAfterMs: number,
) {
  let changed = false;
  for (const [deviceId, claim] of record.claims.entries()) {
    if (timestamp - claim.lastSeenAt > staleAfterMs) {
      record.claims.delete(deviceId);
      changed = true;
    }
  }

  if (record.claims.size === 0) {
    changed = changed || record.hostDeviceId !== "";
    record.hostDeviceId = "";
    return changed;
  }

  if (!record.claims.has(record.hostDeviceId)) {
    const [nextHost] = [...record.claims.values()].sort(compareDevices);
    changed = record.hostDeviceId !== nextHost.deviceId || changed;
    record.hostDeviceId = nextHost.deviceId;
    nextHost.role = "host";
  }

  for (const claim of record.claims.values()) {
    const role = claim.deviceId === record.hostDeviceId ? "host" : "phone";
    changed = changed || claim.role !== role;
    claim.role = role;
  }

  return changed;
}

export function normalizeSessionKey(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
}

export function sanitizeHeartbeat(heartbeat: DeviceHeartbeat): DeviceHeartbeat {
  return {
    mic: heartbeat.mic,
    micLevel: clampNumber(heartbeat.micLevel, 0, 1),
    sampleRate: heartbeat.sampleRate ?? null,
    clockQuality: clampNumber(heartbeat.clockQuality, 0, 1),
    clockOffsetMs: finiteNumber(heartbeat.clockOffsetMs),
    clockUncertaintyMs: heartbeat.clockUncertaintyMs ?? null,
    clockMaxErrorMs: nonNegativeNumber(heartbeat.clockMaxErrorMs),
    clockBestRoundTripMs: nonNegativeNumber(heartbeat.clockBestRoundTripMs),
    clockJitterMs: nonNegativeNumber(heartbeat.clockJitterMs),
    clockSamplesUsed: integerAtLeast(heartbeat.clockSamplesUsed, 0),
    clockOutliersRejected: integerAtLeast(heartbeat.clockOutliersRejected, 0),
    clockOffsetStabilityMs: nonNegativeNumber(heartbeat.clockOffsetStabilityMs),
    audioFrame: sanitizeAudioFrame(heartbeat.audioFrame),
    acousticPulse: sanitizeAcousticPulse(heartbeat.acousticPulse),
    acousticPulses: null,
    acousticObservation: sanitizeAcousticObservation(
      heartbeat.acousticObservation,
    ),
    acousticObservations: null,
    voiceEvent: sanitizeVoiceActivityEvent(heartbeat.voiceEvent),
    voiceEvents: null,
    motion: heartbeat.motion,
    motionAccelerationX: finiteNumber(heartbeat.motionAccelerationX),
    motionAccelerationY: finiteNumber(heartbeat.motionAccelerationY),
    motionAccelerationZ: finiteNumber(heartbeat.motionAccelerationZ),
    motionAccelerationIncludingGravityX: finiteNumber(
      heartbeat.motionAccelerationIncludingGravityX,
    ),
    motionAccelerationIncludingGravityY: finiteNumber(
      heartbeat.motionAccelerationIncludingGravityY,
    ),
    motionAccelerationIncludingGravityZ: finiteNumber(
      heartbeat.motionAccelerationIncludingGravityZ,
    ),
    motionAccelerationMagnitude: nonNegativeNumber(
      heartbeat.motionAccelerationMagnitude,
    ),
    motionRotationAlpha: finiteNumber(heartbeat.motionRotationAlpha),
    motionRotationBeta: finiteNumber(heartbeat.motionRotationBeta),
    motionRotationGamma: finiteNumber(heartbeat.motionRotationGamma),
    motionRotationRateDegPerSec: nonNegativeNumber(
      heartbeat.motionRotationRateDegPerSec,
    ),
    motionIntervalMs: nonNegativeNumber(heartbeat.motionIntervalMs),
    motionCapturedAtClientPerfMs: nonNegativeNumber(
      heartbeat.motionCapturedAtClientPerfMs,
    ),
    motionStability: clampNumber(heartbeat.motionStability, 0, 1),
    heading: heartbeat.heading,
    headingDegrees: normalizedDegrees(heartbeat.headingDegrees),
    orientationBetaDegrees: finiteNumber(heartbeat.orientationBetaDegrees),
    orientationGammaDegrees: finiteNumber(heartbeat.orientationGammaDegrees),
    orientationAbsolute: booleanOrNull(heartbeat.orientationAbsolute),
    location: heartbeat.location,
    locationLatitude: boundedNumber(heartbeat.locationLatitude, -90, 90),
    locationLongitude: boundedNumber(heartbeat.locationLongitude, -180, 180),
    locationAccuracyMeters: nonNegativeNumber(heartbeat.locationAccuracyMeters),
    locationAltitudeMeters: finiteNumber(heartbeat.locationAltitudeMeters),
    locationAltitudeAccuracyMeters: nonNegativeNumber(
      heartbeat.locationAltitudeAccuracyMeters,
    ),
    locationHeadingDegrees: normalizedDegrees(heartbeat.locationHeadingDegrees),
    locationSpeedMetersPerSecond: nonNegativeNumber(
      heartbeat.locationSpeedMetersPerSecond,
    ),
    locationCapturedAtEpochMs: nonNegativeNumber(
      heartbeat.locationCapturedAtEpochMs,
    ),
  };
}

export function mergeHeartbeat(
  previous: DeviceHeartbeat | null | undefined,
  heartbeat: DeviceHeartbeat,
): DeviceHeartbeat {
  const sanitized = sanitizeHeartbeat(heartbeat);
  const acousticPulses = appendAcousticPulseHistory(
    previous?.acousticPulses,
    previous?.acousticPulse,
    sanitized.acousticPulse,
  );
  const acousticObservations = appendAcousticObservationHistory(
    previous?.acousticObservations,
    previous?.acousticObservation,
    sanitized.acousticObservation,
  );
  const voiceEvents = appendVoiceEventHistory(
    previous?.voiceEvents,
    previous?.voiceEvent,
    sanitized.voiceEvent,
  );

  return {
    ...sanitized,
    acousticPulses,
    acousticObservations,
    voiceEvents,
  };
}

function appendAcousticPulseHistory(
  history: AcousticPulse[] | null | undefined,
  previousLatest: AcousticPulse | null | undefined,
  next: AcousticPulse | null | undefined,
) {
  return appendUniqueHistory(history, previousLatest, next, (pulse) => pulse.id);
}

function appendAcousticObservationHistory(
  history: AcousticObservation[] | null | undefined,
  previousLatest: AcousticObservation | null | undefined,
  next: AcousticObservation | null | undefined,
) {
  return appendUniqueHistory(
    history,
    previousLatest,
    next,
    (observation) => observation.pulseId,
  );
}

function appendVoiceEventHistory(
  history: VoiceActivityEvent[] | null | undefined,
  previousLatest: VoiceActivityEvent | null | undefined,
  next: VoiceActivityEvent | null | undefined,
) {
  return appendUniqueHistory(history, previousLatest, next, (event) => event.id);
}

function appendUniqueHistory<T>(
  history: T[] | null | undefined,
  previousLatest: T | null | undefined,
  next: T | null | undefined,
  keyFor: (item: T) => string,
) {
  const entries = [...(history ?? [])];
  if (previousLatest) {
    entries.push(previousLatest);
  }
  if (next) {
    entries.push(next);
  }

  const deduped = new Map<string, T>();
  for (const entry of entries) {
    deduped.delete(keyFor(entry));
    deduped.set(keyFor(entry), entry);
  }

  return [...deduped.values()].slice(-MAX_ACOUSTIC_HISTORY);
}

function sanitizeAudioFrame(
  frame: AudioFrameTimestamp | null | undefined,
): AudioFrameTimestamp | null {
  if (!frame) {
    return null;
  }

  const sampleRate = finiteNumber(frame.sampleRate);
  const sampleIndex = finiteNumber(frame.sampleIndex);
  const audioContextTimeSeconds = finiteNumber(frame.audioContextTimeSeconds);
  const clientPerfOriginEpochMs = finiteNumber(frame.clientPerfOriginEpochMs);
  const performanceNowMs = finiteNumber(frame.performanceNowMs);
  const clockOffsetMs = finiteNumber(frame.clockOffsetMs);
  const clockUncertaintyMs = finiteNumber(frame.clockUncertaintyMs);
  const clockQuality = clampNumber(frame.clockQuality, 0, 1);
  const clockMaxErrorMs = nonNegativeNumber(frame.clockMaxErrorMs);
  const clockBestRoundTripMs = nonNegativeNumber(frame.clockBestRoundTripMs);
  const clockJitterMs = nonNegativeNumber(frame.clockJitterMs);
  const clockSamplesUsed = integerAtLeast(frame.clockSamplesUsed, 0);
  const clockOutliersRejected = integerAtLeast(frame.clockOutliersRejected, 0);
  const clockOffsetStabilityMs = nonNegativeNumber(frame.clockOffsetStabilityMs);
  const timingConfidence = clampNumber(frame.timingConfidence, 0, 1);
  const audioElapsedMs = finiteNumber(frame.audioElapsedMs);
  const hostEstimatedEpochMs = finiteNumber(frame.hostEstimatedEpochMs);

  if (
    sampleRate === null ||
    sampleRate <= 0 ||
    sampleIndex === null ||
    audioContextTimeSeconds === null ||
    clientPerfOriginEpochMs === null ||
    performanceNowMs === null ||
    clockOffsetMs === null ||
    clockUncertaintyMs === null ||
    audioElapsedMs === null ||
    hostEstimatedEpochMs === null
  ) {
    return null;
  }

  return {
    audioContextTimeSeconds,
    sampleIndex: Math.max(0, Math.round(sampleIndex)),
    sampleRate,
    clientPerfOriginEpochMs,
    performanceNowMs,
    clockOffsetMs,
    clockUncertaintyMs,
    clockQuality,
    clockMaxErrorMs,
    clockBestRoundTripMs,
    clockJitterMs,
    clockSamplesUsed,
    clockOutliersRejected,
    clockOffsetStabilityMs,
    timingConfidence:
      timingConfidence ??
      timestampConfidence({
        clockUncertaintyMs,
        clockQuality,
        clockMaxErrorMs,
        clockBestRoundTripMs,
        clockJitterMs,
        clockSamplesUsed,
        clockOffsetStabilityMs,
      }),
    audioElapsedMs,
    hostEstimatedEpochMs,
  };
}

function sanitizeAcousticPulse(
  pulse: AcousticPulse | null | undefined,
): AcousticPulse | null {
  if (!pulse) {
    return null;
  }

  const emittedAtHostEpochMs = finiteNumber(pulse.emittedAtHostEpochMs);
  const emittedSampleIndex = finiteNumber(pulse.emittedSampleIndex);
  const sampleRate = finiteNumber(pulse.sampleRate);
  const durationMs = finiteNumber(pulse.durationMs);
  const frequencyHz = finiteNumber(pulse.frequencyHz);
  const endFrequencyHz = finiteNumber(pulse.endFrequencyHz);

  if (
    typeof pulse.id !== "string" ||
    pulse.id.length === 0 ||
    emittedAtHostEpochMs === null ||
    durationMs === null ||
    durationMs <= 0 ||
    frequencyHz === null ||
    frequencyHz <= 0
  ) {
    return null;
  }

  return {
    id: pulse.id.slice(0, 80),
    emittedAtHostEpochMs,
    emittedSampleIndex:
      emittedSampleIndex === null
        ? null
        : Math.max(0, Math.round(emittedSampleIndex)),
    sampleRate: sampleRate && sampleRate > 0 ? sampleRate : null,
    durationMs,
    frequencyHz,
    endFrequencyHz: endFrequencyHz && endFrequencyHz > 0 ? endFrequencyHz : null,
  };
}

function sanitizeAcousticObservation(
  observation: AcousticObservation | null | undefined,
): AcousticObservation | null {
  if (!observation) {
    return null;
  }

  const detectedAtHostEpochMs = finiteNumber(observation.detectedAtHostEpochMs);
  const detectedSampleIndex = finiteNumber(observation.detectedSampleIndex);
  const sampleRate = finiteNumber(observation.sampleRate);
  const amplitude = clampNumber(observation.amplitude, 0, 1);
  const confidence = clampNumber(observation.confidence, 0, 1);

  if (
    typeof observation.pulseId !== "string" ||
    observation.pulseId.length === 0 ||
    detectedAtHostEpochMs === null ||
    amplitude === null ||
    confidence === null ||
    confidence <= 0
  ) {
    return null;
  }

  return {
    pulseId: observation.pulseId.slice(0, 80),
    detectedAtHostEpochMs,
    detectedSampleIndex:
      detectedSampleIndex === null
        ? null
        : Math.max(0, Math.round(detectedSampleIndex)),
    sampleRate: sampleRate && sampleRate > 0 ? sampleRate : null,
    amplitude,
    confidence,
    clockUncertaintyMs: observation.clockUncertaintyMs ?? null,
  };
}

function sanitizeVoiceActivityEvent(
  event: VoiceActivityEvent | null | undefined,
): VoiceActivityEvent | null {
  if (!event) {
    return null;
  }

  const detectedAtHostEpochMs = finiteNumber(event.detectedAtHostEpochMs);
  const audioContextTimeSeconds = finiteNumber(event.audioContextTimeSeconds);
  const sampleIndex = finiteNumber(event.sampleIndex);
  const sampleRate = finiteNumber(event.sampleRate);
  const audioLevel = clampNumber(event.audioLevel, 0, 1);
  const confidence = clampNumber(event.confidence, 0, 1);
  const clockOffsetMs = finiteNumber(event.clockOffsetMs);
  const clockUncertaintyMs = nonNegativeNumber(event.clockUncertaintyMs);
  const clockQuality = clampNumber(event.clockQuality, 0, 1);
  const clockMaxErrorMs = nonNegativeNumber(event.clockMaxErrorMs);
  const clockBestRoundTripMs = nonNegativeNumber(event.clockBestRoundTripMs);
  const clockJitterMs = nonNegativeNumber(event.clockJitterMs);
  const clockSamplesUsed = integerAtLeast(event.clockSamplesUsed, 0);
  const clockOutliersRejected = integerAtLeast(event.clockOutliersRejected, 0);
  const clockOffsetStabilityMs = nonNegativeNumber(event.clockOffsetStabilityMs);
  const eventTimingConfidence = clampNumber(event.timingConfidence, 0, 1);
  const motionStability = clampNumber(event.motionStability, 0, 1);

  if (
    typeof event.id !== "string" ||
    event.id.length === 0 ||
    detectedAtHostEpochMs === null ||
    audioContextTimeSeconds === null ||
    sampleIndex === null ||
    sampleRate === null ||
    sampleRate <= 0 ||
    audioLevel === null ||
    confidence === null ||
    confidence <= 0 ||
    clockOffsetMs === null ||
    clockUncertaintyMs === null
  ) {
    return null;
  }

  return {
    id: event.id.slice(0, 80),
    detectedAtHostEpochMs,
    audioContextTimeSeconds,
    sampleIndex: Math.max(0, Math.round(sampleIndex)),
    sampleRate,
    audioLevel,
    confidence,
    clockOffsetMs,
    clockUncertaintyMs,
    clockQuality,
    clockMaxErrorMs,
    clockBestRoundTripMs,
    clockJitterMs,
    clockSamplesUsed,
    clockOutliersRejected,
    clockOffsetStabilityMs,
    timingConfidence:
      eventTimingConfidence ??
      timestampConfidence({
        clockUncertaintyMs,
        clockQuality,
        clockMaxErrorMs,
        clockBestRoundTripMs,
        clockJitterMs,
        clockSamplesUsed,
        clockOffsetStabilityMs,
      }),
    motionStability,
    audioFingerprint: sanitizeSpeechFingerprint(event.audioFingerprint),
  };
}

function sanitizeSpeechFingerprint(
  fingerprint: VoiceActivityEvent["audioFingerprint"],
) {
  if (!fingerprint) {
    return null;
  }

  const sampleRate = finiteNumber(fingerprint.sampleRate);
  const startSampleIndex = finiteNumber(fingerprint.startSampleIndex);
  const centerSampleIndex = finiteNumber(fingerprint.centerSampleIndex);
  const hopMs = nonNegativeNumber(fingerprint.hopMs);
  const windowMs = nonNegativeNumber(fingerprint.windowMs);
  const alignmentHopMs = nonNegativeNumber(fingerprint.alignmentHopMs);
  const alignmentWindowMs = nonNegativeNumber(fingerprint.alignmentWindowMs);
  const values = Array.isArray(fingerprint.values)
    ? fingerprint.values
        .slice(0, 64)
        .map((value) => clampNumber(value, 0, 1))
        .filter((value): value is number => typeof value === "number")
    : [];
  const alignmentValues = Array.isArray(fingerprint.alignmentValues)
    ? fingerprint.alignmentValues
        .slice(0, 128)
        .map((value) => clampNumber(value, -1, 1))
        .filter((value): value is number => typeof value === "number")
    : null;

  if (
    sampleRate === null ||
    sampleRate <= 0 ||
    startSampleIndex === null ||
    centerSampleIndex === null ||
    hopMs === null ||
    hopMs <= 0 ||
    windowMs === null ||
    windowMs <= 0 ||
    values.length < 4
  ) {
    return null;
  }

  const sanitized = {
    sampleRate,
    startSampleIndex: Math.max(0, Math.round(startSampleIndex)),
    centerSampleIndex: Math.max(0, Math.round(centerSampleIndex)),
    hopMs,
    windowMs,
    values,
  };

  if (
    alignmentHopMs !== null &&
    alignmentHopMs > 0 &&
    alignmentWindowMs !== null &&
    alignmentWindowMs > 0 &&
    alignmentValues &&
    alignmentValues.length >= 4
  ) {
    return {
      ...sanitized,
      alignmentHopMs,
      alignmentWindowMs,
      alignmentValues,
    };
  }

  return sanitized;
}

function clampNumber(value: number | null | undefined, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value ?? null;
  }

  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function nonNegativeNumber(value: number | null | undefined) {
  const finite = finiteNumber(value);
  return finite === null ? null : Math.max(0, finite);
}

function integerAtLeast(value: number | null | undefined, min: number) {
  const finite = finiteNumber(value);
  return finite === null ? null : Math.max(min, Math.round(finite));
}

function boundedNumber(
  value: number | null | undefined,
  min: number,
  max: number,
) {
  const finite = finiteNumber(value);
  if (finite === null || finite < min || finite > max) {
    return null;
  }

  return finite;
}

function normalizedDegrees(value: number | null | undefined) {
  const finite = finiteNumber(value);
  if (finite === null) {
    return null;
  }

  return ((finite % 360) + 360) % 360;
}

function booleanOrNull(value: boolean | null | undefined) {
  return typeof value === "boolean" ? value : null;
}

function compareDevices(a: RoomDevice, b: RoomDevice) {
  if (a.role !== b.role) {
    return a.role === "host" ? -1 : 1;
  }

  return a.joinedAt - b.joinedAt;
}
