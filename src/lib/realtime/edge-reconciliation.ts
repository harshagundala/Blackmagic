import type {
  AcousticObservation,
  AcousticPulse,
  RoomDevice,
} from "../session/registry";
import {
  deriveAcousticRanges,
  type AcousticRange,
  type AcousticRangeOptions,
} from "../session/ranging";

// Mirrors the server registry's bounded acoustic history so edge-derived
// ranges agree with what a server reconciliation of the same evidence would
// produce.
const MAX_EDGE_HISTORY = 8;

export type EdgeAcousticEvidence = {
  pulses: Map<string, AcousticPulse[]>;
  observations: Map<string, AcousticObservation[]>;
};

// A moved device's chirp history describes geometry that no longer exists;
// dropping its pulses and observations forces the next reciprocal exchange
// to measure fresh instead of blending pre-move distances into the median.
export function clearEdgeEvidenceForDevice(
  evidence: EdgeAcousticEvidence,
  deviceId: string,
) {
  evidence.pulses.delete(deviceId);
  evidence.observations.delete(deviceId);
}

export function createEdgeEvidence(): EdgeAcousticEvidence {
  return {
    pulses: new Map(),
    observations: new Map(),
  };
}

// Returns true when the pulse was new for that device (callers can use this
// to invalidate cached layouts only when evidence actually changed).
export function recordEdgePulse(
  evidence: EdgeAcousticEvidence,
  deviceId: string,
  pulse: AcousticPulse | null | undefined,
) {
  if (!deviceId || !pulse?.id) {
    return false;
  }
  return appendUnique(evidence.pulses, deviceId, pulse, (item) => item.id);
}

export function recordEdgeObservation(
  evidence: EdgeAcousticEvidence,
  deviceId: string,
  observation: AcousticObservation | null | undefined,
) {
  if (!deviceId || !observation?.pulseId) {
    return false;
  }
  return appendUnique(
    evidence.observations,
    deviceId,
    observation,
    (item) =>
      `${item.pulseId}:${item.detectedSampleIndex ?? ""}:${item.detectedAtHostEpochMs}`,
  );
}

// Derives pairwise ranges from locally collected chirp evidence, exactly as
// the server registry would, but without a server round trip. Runs on every
// device; the host relays peer evidence so all devices converge on the same
// inputs.
export function deriveEdgeRanges(
  evidence: EdgeAcousticEvidence,
  options: AcousticRangeOptions = {},
): AcousticRange[] {
  const deviceIds = [
    ...new Set([...evidence.pulses.keys(), ...evidence.observations.keys()]),
  ].sort();
  if (deviceIds.length < 2) {
    return [];
  }

  const devices = deviceIds.map((deviceId) =>
    edgeDevice(
      deviceId,
      evidence.pulses.get(deviceId) ?? [],
      evidence.observations.get(deviceId) ?? [],
    ),
  );

  return deriveAcousticRanges(devices, options);
}

// Combines server-derived and edge-derived ranges, keeping the fresher
// measurement per device pair (edge wins ties: it has lower latency).
export function mergeAcousticRanges(
  serverRanges: AcousticRange[],
  edgeRanges: AcousticRange[],
): AcousticRange[] {
  const byPair = new Map<string, AcousticRange>();
  for (const range of serverRanges) {
    byPair.set(pairKey(range), range);
  }
  for (const range of edgeRanges) {
    const key = pairKey(range);
    const existing = byPair.get(key);
    if (
      !existing ||
      range.observedAtHostEpochMs >= existing.observedAtHostEpochMs
    ) {
      byPair.set(key, range);
    }
  }

  return [...byPair.values()].sort((a, b) =>
    pairKey(a).localeCompare(pairKey(b)),
  );
}

function pairKey(range: AcousticRange) {
  return [range.from, range.to].sort().join(":");
}

function edgeDevice(
  deviceId: string,
  pulses: AcousticPulse[],
  observations: AcousticObservation[],
): RoomDevice {
  return {
    deviceId,
    joinedAt: 0,
    lastSeenAt: 0,
    role: "phone",
    sessionKey: "edge",
    acousticPulses: pulses,
    acousticObservations: observations,
    acousticPulse: null,
    acousticObservation: null,
  };
}

function appendUnique<T>(
  store: Map<string, T[]>,
  deviceId: string,
  item: T,
  keyFor: (item: T) => string,
) {
  const history = store.get(deviceId) ?? [];
  const key = keyFor(item);
  const existingIndex = history.findIndex((entry) => keyFor(entry) === key);
  if (existingIndex >= 0) {
    history.splice(existingIndex, 1);
    history.push(item);
    store.set(deviceId, history.slice(-MAX_EDGE_HISTORY));
    return false;
  }

  history.push(item);
  store.set(deviceId, history.slice(-MAX_EDGE_HISTORY));
  return true;
}
