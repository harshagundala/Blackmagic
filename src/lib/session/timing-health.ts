import { timestampConfidence } from "../timing/clock-sync";
import type { RoomDevice } from "./registry";

export type DeviceTimeSyncState = {
  deviceId: string;
  quality: number;
  maxErrorMs: number | null;
  uncertaintyMs: number | null;
  bestRoundTripMs: number | null;
  jitterMs: number | null;
  offsetStabilityMs: number | null;
  samplesUsed: number;
  timingConfidence: number;
  synchronized: boolean;
  localizationReady: boolean;
};

export type RoomTimeSyncState = {
  status: "solo" | "warming" | "ready" | "degraded";
  synchronizedDeviceIds: string[];
  localizationDeviceIds: string[];
  roomConfidence: number;
  medianMaxErrorMs: number | null;
  worstLocalizationErrorMs: number | null;
  devices: DeviceTimeSyncState[];
};

const MIN_SYNC_SAMPLES = 3;
const MIN_LOCALIZATION_SAMPLES = 4;
const MAX_SYNC_ERROR_MS = 25;
const MAX_LOCALIZATION_ERROR_MS = 12;
const MAX_LOCALIZATION_JITTER_MS = 8;
const MAX_LOCALIZATION_ROUND_TRIP_MS = 160;
const MIN_SYNC_QUALITY = 0.45;
const MIN_LOCALIZATION_QUALITY = 0.55;
const MIN_LOCALIZATION_TIMING_CONFIDENCE = 0.35;

export function deriveRoomTimeSync(devices: RoomDevice[]): RoomTimeSyncState {
  const deviceStates = devices.map(deriveDeviceTimeSync);
  const synchronized = deviceStates.filter((device) => device.synchronized);
  const localizationReady = deviceStates.filter(
    (device) => device.localizationReady,
  );
  const finiteMaxErrors = deviceStates
    .map((device) => device.maxErrorMs)
    .filter(isFiniteNumber)
    .sort((a, b) => a - b);
  const localizationErrors = localizationReady
    .map((device) => device.maxErrorMs)
    .filter(isFiniteNumber);

  return {
    status: roomTimeSyncStatus(deviceStates, localizationReady.length),
    synchronizedDeviceIds: synchronized.map((device) => device.deviceId),
    localizationDeviceIds: localizationReady.map((device) => device.deviceId),
    roomConfidence: roomConfidence(localizationReady),
    medianMaxErrorMs:
      finiteMaxErrors.length === 0 ? null : round(median(finiteMaxErrors), 3),
    worstLocalizationErrorMs:
      localizationErrors.length === 0
        ? null
        : round(Math.max(...localizationErrors), 3),
    devices: deviceStates,
  };
}

function deriveDeviceTimeSync(device: RoomDevice): DeviceTimeSyncState {
  const quality = finiteOr(
    device.clockQuality ?? device.audioFrame?.clockQuality,
    0,
  );
  const uncertaintyMs = firstFinite(
    device.clockUncertaintyMs,
    device.audioFrame?.clockUncertaintyMs,
  );
  const explicitMaxErrorMs = firstFinite(
    device.clockMaxErrorMs,
    device.audioFrame?.clockMaxErrorMs,
  );
  const maxErrorMs =
    explicitMaxErrorMs ?? uncertaintyMs ?? null;
  const bestRoundTripMs = firstFinite(
    device.clockBestRoundTripMs,
    device.audioFrame?.clockBestRoundTripMs,
  );
  const jitterMs = firstFinite(
    device.clockJitterMs,
    device.audioFrame?.clockJitterMs,
  );
  const offsetStabilityMs = firstFinite(
    device.clockOffsetStabilityMs,
    device.audioFrame?.clockOffsetStabilityMs,
  );
  const samplesUsed = Math.max(
    0,
    Math.floor(
      finiteOr(device.clockSamplesUsed ?? device.audioFrame?.clockSamplesUsed, 0),
    ),
  );
  const timingConfidence = timestampConfidence({
    clockUncertaintyMs: uncertaintyMs ?? Number.POSITIVE_INFINITY,
    clockQuality: quality,
    clockMaxErrorMs: maxErrorMs,
    clockBestRoundTripMs: bestRoundTripMs,
    clockJitterMs: jitterMs,
    clockSamplesUsed: samplesUsed,
    clockOffsetStabilityMs: offsetStabilityMs,
  });
  const synchronized =
    samplesUsed >= MIN_SYNC_SAMPLES &&
    quality >= MIN_SYNC_QUALITY &&
    finiteOr(maxErrorMs, Number.POSITIVE_INFINITY) <= MAX_SYNC_ERROR_MS;
  const localizationReady =
    samplesUsed >= MIN_LOCALIZATION_SAMPLES &&
    quality >= MIN_LOCALIZATION_QUALITY &&
    timingConfidence >= MIN_LOCALIZATION_TIMING_CONFIDENCE &&
    finiteOr(maxErrorMs, Number.POSITIVE_INFINITY) <=
      MAX_LOCALIZATION_ERROR_MS &&
    finiteOr(jitterMs, 0) <= MAX_LOCALIZATION_JITTER_MS &&
    finiteOr(bestRoundTripMs, 0) <= MAX_LOCALIZATION_ROUND_TRIP_MS;

  return {
    deviceId: device.deviceId,
    quality: round(clamp(quality, 0, 1), 3),
    maxErrorMs: maxErrorMs === null ? null : round(maxErrorMs, 3),
    uncertaintyMs: uncertaintyMs === null ? null : round(uncertaintyMs, 3),
    bestRoundTripMs:
      bestRoundTripMs === null ? null : round(bestRoundTripMs, 3),
    jitterMs: jitterMs === null ? null : round(jitterMs, 3),
    offsetStabilityMs:
      offsetStabilityMs === null ? null : round(offsetStabilityMs, 3),
    samplesUsed,
    timingConfidence,
    synchronized,
    localizationReady,
  };
}

function roomTimeSyncStatus(
  devices: DeviceTimeSyncState[],
  localizationReadyCount: number,
): RoomTimeSyncState["status"] {
  if (devices.length < 2) {
    return "solo";
  }
  if (localizationReadyCount >= 2) {
    return "ready";
  }
  if (
    devices.some(
      (device) =>
        device.samplesUsed < MIN_LOCALIZATION_SAMPLES ||
        device.maxErrorMs === null,
    )
  ) {
    return "warming";
  }
  return "degraded";
}

function roomConfidence(devices: DeviceTimeSyncState[]) {
  if (devices.length < 2) {
    return 0;
  }
  return round(
    average(
      devices.map((device) => device.timingConfidence * device.quality),
    ),
    3,
  );
}

function firstFinite(...values: Array<number | null | undefined>) {
  return values.find(isFiniteNumber) ?? null;
}

function finiteOr(value: number | null | undefined, fallback: number) {
  return isFiniteNumber(value) ? value : fallback;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle];
  }
  return (values[middle - 1] + values[middle]) / 2;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
