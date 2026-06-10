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
  acousticPulseDeviceCount: number;
  acousticObservationDeviceCount: number;
  sampleAnchoredObservationDeviceCount: number;
  completeReciprocalExchangeCount: number;
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
  acousticPulseCount: number;
  acousticObservationCount: number;
  sampleAnchoredObservationCount: number;
  blockers: string[];
};

export type PhysicalRoomValidationPairDiagnostic = {
  from: string;
  to: string;
  status: PhysicalRoomValidationStatus;
  distanceMeters: number | null;
  distanceUncertaintyMeters: number | null;
  confidence: number | null;
  reciprocalExchangeCount: number;
  fromPulseCount: number;
  toPulseCount: number;
  fromSampleAnchoredObservationCount: number;
  toSampleAnchoredObservationCount: number;
  missingAnchors: string[];
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
  pairs: PhysicalRoomValidationPairDiagnostic[];
  blockers: string[];
};

const MAX_READY_LAYOUT_STRESS_METERS = 0.35;
const MAX_READY_AUDIO_TIMESTAMP_ERROR_MS = 12;
const MIN_READY_AUDIO_TIMING_CONFIDENCE = 0.35;
const MAX_READY_SOURCE_RESIDUAL_MS = 5;
const MIN_READY_SOURCE_CONFIDENCE = 0.35;
const MAX_RECIPROCAL_ANCHOR_TURN_MS = 12_000;

export function validatePhysicalRoomLocalization(
  roomState: RoomState,
  constellation: RoomConstellation = estimateRoomConstellation(roomState),
): PhysicalRoomValidationReport {
  const acousticCalibration = acousticCalibrationDiagnostics(roomState.devices);
  const metrics = validationMetrics(
    roomState,
    constellation,
    acousticCalibration,
  );
  const phoneLayout = phoneLayoutSection(metrics);
  const audioCapture = audioCaptureSection(metrics);
  const audioTimestamps = audioTimestampsSection(metrics);
  const spokenSource = spokenSourceSection(metrics);
  const devices = deviceDiagnostics(
    roomState,
    constellation,
    acousticCalibration,
  );
  const pairs = pairDiagnostics(roomState, acousticCalibration);
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
    pairs,
    blockers,
  };
}

function pairDiagnostics(
  roomState: RoomState,
  acousticCalibration: AcousticCalibrationDiagnostics,
): PhysicalRoomValidationPairDiagnostic[] {
  const calibrationPairs = new Map(
    acousticCalibration.pairs.map((pair) => [`${pair.from}:${pair.to}`, pair]),
  );
  const ranges = new Map(
    roomState.ranges.map((range) => [
      canonicalPairKey(range.from, range.to, roomState.devices),
      range,
    ]),
  );
  const pairs: PhysicalRoomValidationPairDiagnostic[] = [];

  for (let leftIndex = 0; leftIndex < roomState.devices.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < roomState.devices.length;
      rightIndex += 1
    ) {
      const from = roomState.devices[leftIndex].deviceId;
      const to = roomState.devices[rightIndex].deviceId;
      const key = `${from}:${to}`;
      const calibration = calibrationPairs.get(key);
      const range = ranges.get(key);
      const missingAnchors = calibration?.missingAnchors ?? [];
      const blockers = pairBlockers({
        missingAnchors,
        rangeFound: Boolean(range),
        reciprocalExchangeCount: calibration?.reciprocalExchangeCount ?? 0,
      });

      pairs.push({
        from,
        to,
        status: blockers.length === 0 ? "ready" : "warming",
        distanceMeters: roundOrNull(range?.meters),
        distanceUncertaintyMeters: roundOrNull(range?.distanceUncertaintyMeters),
        confidence: roundOrNull(range?.confidence),
        reciprocalExchangeCount: calibration?.reciprocalExchangeCount ?? 0,
        fromPulseCount: calibration?.fromPulseCount ?? 0,
        toPulseCount: calibration?.toPulseCount ?? 0,
        fromSampleAnchoredObservationCount:
          calibration?.fromSampleAnchoredObservationCount ?? 0,
        toSampleAnchoredObservationCount:
          calibration?.toSampleAnchoredObservationCount ?? 0,
        missingAnchors,
        blockers,
      });
    }
  }

  return pairs;
}

function pairBlockers({
  missingAnchors,
  rangeFound,
  reciprocalExchangeCount,
}: {
  missingAnchors: string[];
  rangeFound: boolean;
  reciprocalExchangeCount: number;
}) {
  const blockers: string[] = [];
  if (!rangeFound) {
    blockers.push("no_pairwise_range");
  }
  if (missingAnchors.length > 0) {
    blockers.push("missing_pairwise_anchors");
  }
  if (reciprocalExchangeCount === 0) {
    blockers.push("incomplete_reciprocal_anchors");
  }
  return blockers;
}

function deviceDiagnostics(
  roomState: RoomState,
  constellation: RoomConstellation,
  acousticCalibration: AcousticCalibrationDiagnostics,
): PhysicalRoomValidationDeviceDiagnostic[] {
  const layoutDevices = new Map(
    constellation.devices.map((device) => [device.deviceId, device]),
  );
  const calibrationDevices = new Map(
    acousticCalibration.devices.map((device) => [device.deviceId, device]),
  );

  return roomState.devices.map((device) => {
    const layoutDevice = layoutDevices.get(device.deviceId);
    const calibrationDevice = calibrationDevices.get(device.deviceId);
    const capture = audioCaptureState(device);
    const timestamp = audioTimestampState(device);
    const captureStatus = captureProcessingState(device.captureProcessing);
    const blockers = deviceBlockers({
      calibration: calibrationDevice,
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
      acousticPulseCount: calibrationDevice?.acousticPulseCount ?? 0,
      acousticObservationCount:
        calibrationDevice?.acousticObservationCount ?? 0,
      sampleAnchoredObservationCount:
        calibrationDevice?.sampleAnchoredObservationCount ?? 0,
      blockers,
    };
  });
}

function deviceBlockers({
  calibration,
  device,
  capture,
  captureStatus,
  timestamp,
  localized,
}: {
  calibration: AcousticCalibrationDeviceDiagnostics | undefined;
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
  if (device.mic === "active" && timestamp.present) {
    if ((calibration?.acousticPulseCount ?? 0) === 0) {
      blockers.push("no_acoustic_pulse");
    }
    if ((calibration?.sampleAnchoredObservationCount ?? 0) === 0) {
      blockers.push("no_sample_anchored_observation");
    }
  }

  return blockers;
}

function validationMetrics(
  roomState: RoomState,
  constellation: RoomConstellation,
  acousticCalibration: AcousticCalibrationDiagnostics,
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
    acousticPulseDeviceCount: acousticCalibration.devices.filter(
      (device) => device.acousticPulseCount > 0,
    ).length,
    acousticObservationDeviceCount: acousticCalibration.devices.filter(
      (device) => device.acousticObservationCount > 0,
    ).length,
    sampleAnchoredObservationDeviceCount: acousticCalibration.devices.filter(
      (device) => device.sampleAnchoredObservationCount > 0,
    ).length,
    completeReciprocalExchangeCount:
      acousticCalibration.completeReciprocalExchangeCount,
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
  const requiredCalibrationDevices =
    metrics.deviceCount >= 3 ? 3 : Math.min(2, metrics.deviceCount);
  const requiredRanges = Math.max(1, metrics.deviceCount - 1);
  if (metrics.deviceCount < 2) {
    blockers.push("insufficient_devices");
  }
  if (metrics.clockStatus !== "ready") {
    blockers.push("clock_not_ready");
  }
  if (metrics.rangeCount < requiredRanges) {
    blockers.push("insufficient_acoustic_ranges");
    if (
      metrics.deviceCount >= 2 &&
      metrics.acousticPulseDeviceCount < requiredCalibrationDevices
    ) {
      blockers.push("missing_acoustic_pulses");
    }
    if (
      metrics.deviceCount >= 2 &&
      metrics.acousticObservationDeviceCount < requiredCalibrationDevices
    ) {
      blockers.push("missing_acoustic_observations");
    }
    if (
      metrics.deviceCount >= 2 &&
      metrics.sampleAnchoredObservationDeviceCount <
        requiredCalibrationDevices
    ) {
      blockers.push("missing_sample_anchored_observations");
    }
    if (
      metrics.deviceCount >= 2 &&
      metrics.completeReciprocalExchangeCount < requiredRanges
    ) {
      blockers.push("incomplete_reciprocal_anchors");
    }
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

type AcousticCalibrationDeviceDiagnostics = {
  deviceId: string;
  acousticPulseCount: number;
  acousticObservationCount: number;
  sampleAnchoredObservationCount: number;
};

type AcousticCalibrationPairDiagnostics = {
  from: string;
  to: string;
  reciprocalExchangeCount: number;
  fromPulseCount: number;
  toPulseCount: number;
  fromSampleAnchoredObservationCount: number;
  toSampleAnchoredObservationCount: number;
  missingAnchors: string[];
};

type AcousticCalibrationDiagnostics = {
  devices: AcousticCalibrationDeviceDiagnostics[];
  pairs: AcousticCalibrationPairDiagnostics[];
  completeReciprocalExchangeCount: number;
};

type PulseWithDevice = {
  device: RoomDevice;
  pulse: NonNullable<RoomDevice["acousticPulse"]>;
};

function acousticCalibrationDiagnostics(
  devices: RoomDevice[],
): AcousticCalibrationDiagnostics {
  const observationsByDevice = new Map(
    devices.map((device) => [
      device.deviceId,
      new Map(
        acousticObservationHistory(device).map((observation) => [
          observation.pulseId,
          observation,
        ]),
      ),
    ]),
  );
  const pulsesByDevice = new Map(
    devices.map((device) => [
      device.deviceId,
      acousticPulseHistory(device)
        .map((pulse) => ({ device, pulse }))
        .sort((a, b) => a.pulse.emittedAtHostEpochMs - b.pulse.emittedAtHostEpochMs),
    ]),
  );

  return {
    devices: devices.map((device) => {
      const observations = acousticObservationHistory(device);
      return {
        deviceId: device.deviceId,
        acousticPulseCount: acousticPulseHistory(device).length,
        acousticObservationCount: observations.length,
        sampleAnchoredObservationCount: observations.filter(hasSampleAnchor)
          .length,
      };
    }),
    completeReciprocalExchangeCount: completeReciprocalExchangeCount(
      devices,
      pulsesByDevice,
      observationsByDevice,
    ),
    pairs: acousticPairDiagnostics(
      devices,
      pulsesByDevice,
      observationsByDevice,
    ),
  };
}

function acousticPairDiagnostics(
  devices: RoomDevice[],
  pulsesByDevice: Map<string, PulseWithDevice[]>,
  observationsByDevice: Map<
    string,
    Map<string, NonNullable<RoomDevice["acousticObservation"]>>
  >,
): AcousticCalibrationPairDiagnostics[] {
  const diagnostics: AcousticCalibrationPairDiagnostics[] = [];

  for (let leftIndex = 0; leftIndex < devices.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < devices.length;
      rightIndex += 1
    ) {
      const from = devices[leftIndex];
      const to = devices[rightIndex];
      const fromPulses = pulsesByDevice.get(from.deviceId) ?? [];
      const toPulses = pulsesByDevice.get(to.deviceId) ?? [];
      const reciprocalPairs = reciprocalPulsePairs(fromPulses, toPulses);
      const missingAnchors = pairMissingAnchors(
        from,
        to,
        reciprocalPairs,
        observationsByDevice,
      );

      diagnostics.push({
        from: from.deviceId,
        to: to.deviceId,
        reciprocalExchangeCount: reciprocalPairs.filter(([first, second]) =>
          hasCompleteReciprocalAnchors(first, second, observationsByDevice),
        ).length,
        fromPulseCount: fromPulses.length,
        toPulseCount: toPulses.length,
        fromSampleAnchoredObservationCount: sampleAnchoredObservationCount(
          from,
          observationsByDevice,
        ),
        toSampleAnchoredObservationCount: sampleAnchoredObservationCount(
          to,
          observationsByDevice,
        ),
        missingAnchors,
      });
    }
  }

  return diagnostics;
}

function pairMissingAnchors(
  from: RoomDevice,
  to: RoomDevice,
  reciprocalPairs: Array<[PulseWithDevice, PulseWithDevice]>,
  observationsByDevice: Map<
    string,
    Map<string, NonNullable<RoomDevice["acousticObservation"]>>
  >,
) {
  const missing: string[] = [];
  const fromObservations = observationsByDevice.get(from.deviceId) ?? new Map();
  const toObservations = observationsByDevice.get(to.deviceId) ?? new Map();

  if (reciprocalPairs.length === 0) {
    if (acousticPulseHistory(from).length === 0) {
      missing.push("from_pulse");
    }
    if (acousticPulseHistory(to).length === 0) {
      missing.push("to_pulse");
    }
  }

  if (sampleAnchoredObservationCount(from, observationsByDevice) === 0) {
    missing.push("from_sample_anchored_observation");
  }
  if (sampleAnchoredObservationCount(to, observationsByDevice) === 0) {
    missing.push("to_sample_anchored_observation");
  }

  const bestPair = reciprocalPairs[0];
  if (!bestPair) {
    return unique(missing);
  }

  const [first, second] = bestPair;
  const firstIsFrom = first.device.deviceId === from.deviceId;
  const fromPulse = firstIsFrom ? first.pulse : second.pulse;
  const toPulse = firstIsFrom ? second.pulse : first.pulse;

  if (!hasSampleAnchor(fromObservations.get(fromPulse.id))) {
    missing.push("from_self_observation");
  }
  if (!hasSampleAnchor(fromObservations.get(toPulse.id))) {
    missing.push("from_heard_to_observation");
  }
  if (!hasSampleAnchor(toObservations.get(fromPulse.id))) {
    missing.push("to_heard_from_observation");
  }
  if (!hasSampleAnchor(toObservations.get(toPulse.id))) {
    missing.push("to_self_observation");
  }

  return unique(missing);
}

function sampleAnchoredObservationCount(
  device: RoomDevice,
  observationsByDevice: Map<
    string,
    Map<string, NonNullable<RoomDevice["acousticObservation"]>>
  >,
) {
  return [...(observationsByDevice.get(device.deviceId)?.values() ?? [])].filter(
    hasSampleAnchor,
  ).length;
}

function canonicalPairKey(from: string, to: string, devices: RoomDevice[]) {
  const deviceOrder = new Map(
    devices.map((device, index) => [device.deviceId, index]),
  );
  const fromOrder = deviceOrder.get(from) ?? Number.MAX_SAFE_INTEGER;
  const toOrder = deviceOrder.get(to) ?? Number.MAX_SAFE_INTEGER;
  return fromOrder <= toOrder ? `${from}:${to}` : `${to}:${from}`;
}

function completeReciprocalExchangeCount(
  devices: RoomDevice[],
  pulsesByDevice: Map<string, PulseWithDevice[]>,
  observationsByDevice: Map<
    string,
    Map<string, NonNullable<RoomDevice["acousticObservation"]>>
  >,
) {
  let count = 0;
  for (let leftIndex = 0; leftIndex < devices.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < devices.length;
      rightIndex += 1
    ) {
      const left = devices[leftIndex];
      const right = devices[rightIndex];
      const reciprocalPairs = reciprocalPulsePairs(
        pulsesByDevice.get(left.deviceId) ?? [],
        pulsesByDevice.get(right.deviceId) ?? [],
      );
      for (const [first, second] of reciprocalPairs) {
        if (hasCompleteReciprocalAnchors(first, second, observationsByDevice)) {
          count += 1;
        }
      }
    }
  }

  return count;
}

function hasCompleteReciprocalAnchors(
  first: PulseWithDevice,
  second: PulseWithDevice,
  observationsByDevice: Map<
    string,
    Map<string, NonNullable<RoomDevice["acousticObservation"]>>
  >,
) {
  const firstObservations =
    observationsByDevice.get(first.device.deviceId) ?? new Map();
  const secondObservations =
    observationsByDevice.get(second.device.deviceId) ?? new Map();

  return (
    hasSampleAnchor(firstObservations.get(first.pulse.id)) &&
    hasSampleAnchor(firstObservations.get(second.pulse.id)) &&
    hasSampleAnchor(secondObservations.get(first.pulse.id)) &&
    hasSampleAnchor(secondObservations.get(second.pulse.id))
  );
}

function reciprocalPulsePairs(
  leftPulses: PulseWithDevice[],
  rightPulses: PulseWithDevice[],
) {
  const pairs = new Map<string, [PulseWithDevice, PulseWithDevice]>();
  appendForwardPairs(pairs, leftPulses, rightPulses);
  appendForwardPairs(pairs, rightPulses, leftPulses);
  return [...pairs.values()].sort(
    ([left], [right]) =>
      left.pulse.emittedAtHostEpochMs - right.pulse.emittedAtHostEpochMs,
  );
}

function appendForwardPairs(
  pairs: Map<string, [PulseWithDevice, PulseWithDevice]>,
  firstPulses: PulseWithDevice[],
  secondPulses: PulseWithDevice[],
) {
  for (const first of firstPulses) {
    const second = secondPulses
      .filter((candidate) => {
        const deltaMs =
          candidate.pulse.emittedAtHostEpochMs -
          first.pulse.emittedAtHostEpochMs;
        return deltaMs > 0 && deltaMs <= MAX_RECIPROCAL_ANCHOR_TURN_MS;
      })
      .sort(
        (a, b) =>
          a.pulse.emittedAtHostEpochMs - b.pulse.emittedAtHostEpochMs,
      )[0];
    if (second) {
      pairs.set(`${first.pulse.id}->${second.pulse.id}`, [first, second]);
    }
  }
}

function acousticPulseHistory(device: RoomDevice) {
  return uniqueBy(
    [
      ...(device.acousticPulses ?? []),
      ...(device.acousticPulse ? [device.acousticPulse] : []),
    ],
    (pulse) => pulse.id,
  );
}

function acousticObservationHistory(device: RoomDevice) {
  return uniqueBy(
    [
      ...(device.acousticObservations ?? []),
      ...(device.acousticObservation ? [device.acousticObservation] : []),
    ],
    (observation) => observation.pulseId,
  );
}

function hasSampleAnchor(
  observation: RoomDevice["acousticObservation"] | undefined,
) {
  return (
    observation !== null &&
    observation !== undefined &&
    typeof observation.detectedSampleIndex === "number" &&
    Number.isFinite(observation.detectedSampleIndex) &&
    observation.detectedSampleIndex >= 0 &&
    typeof observation.sampleRate === "number" &&
    Number.isFinite(observation.sampleRate) &&
    observation.sampleRate > 0
  );
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string) {
  const map = new Map<string, T>();
  for (const item of items) {
    map.delete(keyFor(item));
    map.set(keyFor(item), item);
  }
  return [...map.values()];
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
