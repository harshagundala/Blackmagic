import {
  estimateRoomConstellation,
  type RoomConstellation,
} from "../positioning/room-state-layout";
import {
  captureProcessingState,
  type CaptureProcessingState,
  type RoomDevice,
  type RoomState,
} from "../session/registry";

export type PhysicalRoomValidationStatus = "ready" | "warming" | "degraded";

export type PhysicalRoomValidationSection = {
  status: PhysicalRoomValidationStatus;
  blockers: string[];
};

export type PhysicalRoomValidationMetrics = {
  deviceCount: number;
  localizedDeviceCount: number;
  rangeCount: number;
  layoutStressMeters: number;
  clockStatus: RoomState["timeSync"]["status"];
  worstClockErrorMs: number | null;
  roomClockConfidence: number;
  audioCaptureReadyDeviceCount: number;
  rawCaptureVerifiedDeviceCount: number;
  unverifiedCaptureDeviceCount: number;
  runningAudioContextDeviceCount: number;
  filteredCaptureDeviceCount: number;
  suspendedAudioContextDeviceCount: number;
  audioTimestampDeviceCount: number;
  audioTimestampReadyDeviceCount: number;
  worstAudioTimestampErrorMs: number | null;
  lowestAudioTimingConfidence: number | null;
  tdoaSourceCount: number;
  bestSourceResidualMs: number | null;
  bestSourceConfidence: number | null;
};

export type PhysicalRoomValidationDeviceDiagnostic = {
  deviceId: string;
  role: RoomDevice["role"];
  mic: RoomDevice["mic"] | null;
  localized: boolean;
  distanceMeters: number | null;
  layoutConfidence: number;
  captureStatus: CaptureProcessingState;
  audioCaptureReady: boolean;
  audioContextState: RoomDevice["audioContextState"] | null;
  sampleRate: number | null;
  audioTimestampPresent: boolean;
  audioTimestampReady: boolean;
  audioTimestampErrorMs: number | null;
  audioTimingConfidence: number | null;
  clockMaxErrorMs: number | null;
  clockQuality: number | null;
  motionStability: number | null;
  blockers: string[];
};

export type PhysicalRoomValidationReport = {
  status: PhysicalRoomValidationStatus;
  phoneLayout: PhysicalRoomValidationSection;
  audioCapture: PhysicalRoomValidationSection;
  audioTimestamps: PhysicalRoomValidationSection;
  spokenSource: PhysicalRoomValidationSection;
  metrics: PhysicalRoomValidationMetrics;
  devices: PhysicalRoomValidationDeviceDiagnostic[];
  blockers: string[];
};

const MAX_READY_LAYOUT_STRESS_METERS = 0.35;
const MAX_READY_AUDIO_TIMESTAMP_ERROR_MS = 12;
const MIN_READY_AUDIO_TIMING_CONFIDENCE = 0.35;
const MAX_READY_SOURCE_RESIDUAL_MS = 5;
const MIN_READY_SOURCE_CONFIDENCE = 0.35;

export function validatePhysicalRoomLocalization(
  roomState: RoomState,
  constellation: RoomConstellation = estimateRoomConstellation(roomState),
): PhysicalRoomValidationReport {
  const metrics = validationMetrics(roomState, constellation);
  const phoneLayout = phoneLayoutSection(metrics);
  const audioCapture = audioCaptureSection(metrics);
  const audioTimestamps = audioTimestampsSection(metrics);
  const spokenSource = spokenSourceSection(metrics);
  const devices = deviceDiagnostics(roomState, constellation);
  const sections = [phoneLayout, audioCapture, audioTimestamps, spokenSource];
  const blockers = unique([
    ...phoneLayout.blockers,
    ...audioCapture.blockers,
    ...audioTimestamps.blockers,
    ...spokenSource.blockers,
  ]);

  return {
    status: aggregateStatus(sections),
    phoneLayout,
    audioCapture,
    audioTimestamps,
    spokenSource,
    metrics,
    devices,
    blockers,
  };
}

function deviceDiagnostics(
  roomState: RoomState,
  constellation: RoomConstellation,
): PhysicalRoomValidationDeviceDiagnostic[] {
  const layoutDevices = new Map(
    constellation.devices.map((device) => [device.deviceId, device]),
  );

  return roomState.devices.map((device) => {
    const layoutDevice = layoutDevices.get(device.deviceId);
    const capture = audioCaptureState(device);
    const timestamp = audioTimestampState(device);
    const captureStatus = captureProcessingState(device.captureProcessing);
    const blockers = deviceBlockers({
      device,
      capture,
      captureStatus,
      timestamp,
      localized: layoutDevice?.localized ?? false,
    });

    return {
      deviceId: device.deviceId,
      role: device.role,
      mic: device.mic ?? null,
      localized: layoutDevice?.localized ?? false,
      distanceMeters: roundOrNull(layoutDevice?.distanceMeters),
      layoutConfidence: round(layoutDevice?.confidence ?? 0),
      captureStatus,
      audioCaptureReady: capture.ready,
      audioContextState: device.audioContextState ?? null,
      sampleRate: firstFinite(device.audioFrame?.sampleRate, device.sampleRate),
      audioTimestampPresent: timestamp.present,
      audioTimestampReady: timestamp.ready,
      audioTimestampErrorMs: roundOrNull(timestamp.errorMs),
      audioTimingConfidence: roundOrNull(timestamp.timingConfidence),
      clockMaxErrorMs: roundOrNull(
        firstFinite(
          device.audioFrame?.clockMaxErrorMs,
          device.clockMaxErrorMs,
          device.audioFrame?.clockUncertaintyMs,
          device.clockUncertaintyMs,
        ),
      ),
      clockQuality: roundOrNull(
        firstFinite(device.audioFrame?.clockQuality, device.clockQuality),
      ),
      motionStability: roundOrNull(clampNumber(device.motionStability, 0, 1)),
      blockers,
    };
  });
}

function deviceBlockers({
  device,
  capture,
  captureStatus,
  timestamp,
  localized,
}: {
  device: RoomDevice;
  capture: ReturnType<typeof audioCaptureState>;
  captureStatus: CaptureProcessingState;
  timestamp: ReturnType<typeof audioTimestampState>;
  localized: boolean;
}) {
  const blockers: string[] = [];

  if (device.mic !== "active") {
    blockers.push("mic_not_active");
  }
  if (captureStatus === "missing") {
    blockers.push("audio_capture_missing");
  }
  if (captureStatus === "unverified") {
    blockers.push("audio_capture_unverified");
  }
  if (captureStatus === "filtered") {
    blockers.push("filtered_audio_capture");
  }
  if (!capture.contextRunning) {
    blockers.push("audio_context_not_running");
  }
  if (!timestamp.present) {
    blockers.push("audio_timestamp_missing");
  } else {
    if (
      timestamp.errorMs !== null &&
      timestamp.errorMs > MAX_READY_AUDIO_TIMESTAMP_ERROR_MS
    ) {
      blockers.push("audio_timestamp_error_high");
    }
    if (
      timestamp.timingConfidence !== null &&
      timestamp.timingConfidence < MIN_READY_AUDIO_TIMING_CONFIDENCE
    ) {
      blockers.push("audio_timestamp_confidence_low");
    }
    if (
      !timestamp.ready &&
      timestamp.errorMs !== null &&
      timestamp.errorMs <= MAX_READY_AUDIO_TIMESTAMP_ERROR_MS &&
      timestamp.timingConfidence !== null &&
      timestamp.timingConfidence >= MIN_READY_AUDIO_TIMING_CONFIDENCE
    ) {
      blockers.push("audio_timestamps_not_ready");
    }
  }
  if (!localized) {
    blockers.push("not_localized");
  }

  return blockers;
}

function validationMetrics(
  roomState: RoomState,
  constellation: RoomConstellation,
): PhysicalRoomValidationMetrics {
  const tdoaSources = constellation.audioSources.filter(
    (source) => source.method === "tdoa-grid",
  );
  const sourceResiduals = tdoaSources
    .map((source) => source.residualMs)
    .filter((residual): residual is number => residual !== null);
  const sourceConfidences = tdoaSources.map((source) => source.confidence);
  const timestampStates = roomState.devices.map(audioTimestampState);
  const timestampErrors = timestampStates
    .map((state) => state.errorMs)
    .filter((error): error is number => error !== null);
  const timestampConfidences = timestampStates
    .map((state) => state.timingConfidence)
    .filter((confidence): confidence is number => confidence !== null);
  const captureStates = roomState.devices.map(audioCaptureState);

  return {
    deviceCount: roomState.devices.length,
    localizedDeviceCount: constellation.devices.filter((device) => device.localized)
      .length,
    rangeCount: roomState.ranges.length,
    layoutStressMeters: round(constellation.layout.stress),
    clockStatus: roomState.timeSync.status,
    worstClockErrorMs: roomState.timeSync.worstLocalizationErrorMs,
    roomClockConfidence: roomState.timeSync.roomConfidence,
    audioCaptureReadyDeviceCount: captureStates.filter((state) => state.ready)
      .length,
    rawCaptureVerifiedDeviceCount: captureStates.filter(
      (state) => state.rawVerified,
    ).length,
    unverifiedCaptureDeviceCount: captureStates.filter(
      (state) => state.unverified,
    ).length,
    runningAudioContextDeviceCount: captureStates.filter(
      (state) => state.contextRunning,
    ).length,
    filteredCaptureDeviceCount: captureStates.filter((state) => state.filtered)
      .length,
    suspendedAudioContextDeviceCount: captureStates.filter(
      (state) => state.contextBlocked,
    ).length,
    audioTimestampDeviceCount: timestampStates.filter((state) => state.present)
      .length,
    audioTimestampReadyDeviceCount: timestampStates.filter((state) => state.ready)
      .length,
    worstAudioTimestampErrorMs:
      timestampErrors.length === 0 ? null : round(Math.max(...timestampErrors)),
    lowestAudioTimingConfidence:
      timestampConfidences.length === 0
        ? null
        : round(Math.min(...timestampConfidences)),
    tdoaSourceCount: tdoaSources.length,
    bestSourceResidualMs:
      sourceResiduals.length === 0 ? null : round(Math.min(...sourceResiduals)),
    bestSourceConfidence:
      sourceConfidences.length === 0
        ? null
        : round(Math.max(...sourceConfidences)),
  };
}

function audioCaptureState(device: RoomDevice) {
  const state = captureProcessingState(device.captureProcessing);
  const rawVerified = state === "verified";
  const filtered = state === "filtered";
  const unverified = state === "unverified";
  const contextRunning = device.audioContextState === "running";
  const contextBlocked =
    device.audioContextState !== null &&
    device.audioContextState !== undefined &&
    device.audioContextState !== "running";
  const micActive = device.mic === "active";

  return {
    ready: micActive && rawVerified && contextRunning,
    rawVerified,
    unverified,
    contextRunning,
    filtered,
    contextBlocked,
  };
}

function audioTimestampState(device: RoomDevice) {
  const frame = device.audioFrame;
  const sampleRate = finiteNumber(frame?.sampleRate);
  const present =
    frame !== null &&
    frame !== undefined &&
    finiteNumber(frame.sampleIndex) !== null &&
    finiteNumber(frame.hostEstimatedEpochMs) !== null &&
    sampleRate !== null &&
    sampleRate > 0;
  const errorMs = firstFinite(frame?.clockMaxErrorMs, frame?.clockUncertaintyMs);
  const timingConfidence = clampNumber(frame?.timingConfidence, 0, 1);
  const ready =
    present &&
    errorMs !== null &&
    errorMs <= MAX_READY_AUDIO_TIMESTAMP_ERROR_MS &&
    timingConfidence !== null &&
    timingConfidence >= MIN_READY_AUDIO_TIMING_CONFIDENCE;

  return {
    present,
    ready,
    errorMs,
    timingConfidence,
  };
}

function phoneLayoutSection(
  metrics: PhysicalRoomValidationMetrics,
): PhysicalRoomValidationSection {
  const blockers: string[] = [];
  let degraded = false;
  if (metrics.deviceCount < 2) {
    blockers.push("insufficient_devices");
  }
  if (metrics.clockStatus !== "ready") {
    blockers.push("clock_not_ready");
  }
  if (metrics.rangeCount < Math.max(1, metrics.deviceCount - 1)) {
    blockers.push("insufficient_acoustic_ranges");
  }
  if (metrics.localizedDeviceCount < Math.min(2, metrics.deviceCount)) {
    blockers.push("insufficient_localized_devices");
  }
  if (metrics.layoutStressMeters > MAX_READY_LAYOUT_STRESS_METERS) {
    blockers.push("layout_stress_high");
    degraded = true;
  }

  return {
    status: degraded ? "degraded" : blockers.length === 0 ? "ready" : "warming",
    blockers,
  };
}

function audioCaptureSection(
  metrics: PhysicalRoomValidationMetrics,
): PhysicalRoomValidationSection {
  const blockers: string[] = [];
  const required = requiredAudioCaptureDevices(metrics.deviceCount);
  let degraded = false;
  if (metrics.deviceCount < 2) {
    blockers.push("insufficient_devices");
  }
  if (metrics.audioCaptureReadyDeviceCount < required) {
    blockers.push("insufficient_audio_capture");
  }
  if (metrics.unverifiedCaptureDeviceCount > 0) {
    blockers.push("audio_capture_unverified");
  }
  if (metrics.filteredCaptureDeviceCount > 0) {
    blockers.push("filtered_audio_capture");
    degraded = true;
  }
  if (metrics.suspendedAudioContextDeviceCount > 0) {
    blockers.push("audio_context_not_running");
    degraded = true;
  }

  return {
    status: degraded ? "degraded" : blockers.length === 0 ? "ready" : "warming",
    blockers,
  };
}

function requiredAudioCaptureDevices(deviceCount: number) {
  return deviceCount >= 3 ? 3 : Math.min(2, deviceCount);
}

function audioTimestampsSection(
  metrics: PhysicalRoomValidationMetrics,
): PhysicalRoomValidationSection {
  const blockers: string[] = [];
  const required = requiredAudioTimestampDevices(metrics.deviceCount);
  let degraded = false;
  if (metrics.deviceCount < 2) {
    blockers.push("insufficient_devices");
  }
  if (metrics.audioTimestampDeviceCount < required) {
    blockers.push("insufficient_audio_timestamps");
  }
  if (
    metrics.worstAudioTimestampErrorMs !== null &&
    metrics.worstAudioTimestampErrorMs > MAX_READY_AUDIO_TIMESTAMP_ERROR_MS
  ) {
    blockers.push("audio_timestamp_error_high");
    degraded = true;
  }
  if (
    metrics.lowestAudioTimingConfidence !== null &&
    metrics.lowestAudioTimingConfidence < MIN_READY_AUDIO_TIMING_CONFIDENCE
  ) {
    blockers.push("audio_timestamp_confidence_low");
    degraded = true;
  }
  if (
    !degraded &&
    metrics.audioTimestampDeviceCount >= required &&
    metrics.audioTimestampReadyDeviceCount < required
  ) {
    blockers.push("audio_timestamps_not_ready");
  }

  return {
    status: degraded ? "degraded" : blockers.length === 0 ? "ready" : "warming",
    blockers,
  };
}

function spokenSourceSection(
  metrics: PhysicalRoomValidationMetrics,
): PhysicalRoomValidationSection {
  const blockers: string[] = [];
  let degraded = false;
  if (metrics.deviceCount < 3) {
    blockers.push("insufficient_tdoa_devices");
  }
  if (metrics.tdoaSourceCount === 0) {
    blockers.push("no_tdoa_source");
  }
  if (
    metrics.bestSourceResidualMs !== null &&
    metrics.bestSourceResidualMs > MAX_READY_SOURCE_RESIDUAL_MS
  ) {
    blockers.push("source_residual_high");
    degraded = true;
  }
  if (
    metrics.bestSourceConfidence !== null &&
    metrics.bestSourceConfidence < MIN_READY_SOURCE_CONFIDENCE
  ) {
    blockers.push("source_confidence_low");
    degraded = true;
  }

  return {
    status: degraded ? "degraded" : blockers.length === 0 ? "ready" : "warming",
    blockers,
  };
}

function aggregateStatus(sections: PhysicalRoomValidationSection[]) {
  if (sections.every((section) => section.status === "ready")) {
    return "ready";
  }
  if (sections.some((section) => section.status === "degraded")) {
    return "degraded";
  }
  return "warming";
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function requiredAudioTimestampDevices(deviceCount: number) {
  return deviceCount >= 3 ? 3 : Math.min(2, deviceCount);
}

function firstFinite(...values: Array<number | null | undefined>) {
  for (const value of values) {
    const finite = finiteNumber(value);
    if (finite !== null) {
      return finite;
    }
  }
  return null;
}

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampNumber(
  value: number | null | undefined,
  min: number,
  max: number,
) {
  const finite = finiteNumber(value);
  return finite === null ? null : Math.max(min, Math.min(max, finite));
}

function round(value: number) {
  return Number(value.toFixed(3));
}

function roundOrNull(value: number | null | undefined) {
  const finite = finiteNumber(value);
  return finite === null ? null : round(finite);
}
