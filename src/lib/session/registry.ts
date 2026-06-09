import type { AudioFrameTimestamp } from "@/lib/timing/clock-sync";
import { deriveAcousticRanges, type AcousticRange } from "./ranging";

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
  durationMs: number;
  frequencyHz: number;
  endFrequencyHz?: number | null;
};

export type AcousticObservation = {
  pulseId: string;
  detectedAtHostEpochMs: number;
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
  motion?: SensorState;
  heading?: SensorState;
  location?: SensorState;
};

export type RoomDevice = SessionClaim & DeviceHeartbeat;

export type RoomState = {
  sessionKey: string;
  hostDeviceId: string;
  devices: RoomDevice[];
  ranges: AcousticRange[];
  updatedAt: number;
};

type SessionRecord = {
  hostDeviceId: string;
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
          claims: new Map([[deviceId, claim]]),
        });
        return claim;
      }

      pruneStaleClaims(existing, timestamp, staleAfterMs);

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
        return claim;
      }

      const previous = existing.claims.get(deviceId);
      if (previous) {
        previous.lastSeenAt = timestamp;
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

      Object.assign(current, mergeHeartbeat(current, heartbeat), {
        lastSeenAt: now(),
      });

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
          devices: [],
          ranges: [],
          updatedAt: timestamp,
        };
      }

      pruneStaleClaims(record, timestamp, staleAfterMs);
      const devices = [...record.claims.values()].sort(compareDevices);

      return {
        sessionKey,
        hostDeviceId: record.hostDeviceId,
        devices,
        ranges: deriveAcousticRanges(devices),
        updatedAt: timestamp,
      };
    },
  };
}

function pruneStaleClaims(
  record: SessionRecord,
  timestamp: number,
  staleAfterMs: number,
) {
  for (const [deviceId, claim] of record.claims.entries()) {
    if (timestamp - claim.lastSeenAt > staleAfterMs) {
      record.claims.delete(deviceId);
    }
  }

  if (record.claims.size === 0) {
    record.hostDeviceId = "";
    return;
  }

  if (!record.claims.has(record.hostDeviceId)) {
    const [nextHost] = [...record.claims.values()].sort(compareDevices);
    record.hostDeviceId = nextHost.deviceId;
    nextHost.role = "host";
  }

  for (const claim of record.claims.values()) {
    claim.role = claim.deviceId === record.hostDeviceId ? "host" : "phone";
  }
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
    motion: heartbeat.motion,
    heading: heartbeat.heading,
    location: heartbeat.location,
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

  return {
    ...sanitized,
    acousticPulses,
    acousticObservations,
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
    amplitude,
    confidence,
    clockUncertaintyMs: observation.clockUncertaintyMs ?? null,
  };
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

function compareDevices(a: RoomDevice, b: RoomDevice) {
  if (a.role !== b.role) {
    return a.role === "host" ? -1 : 1;
  }

  return a.joinedAt - b.joinedAt;
}
