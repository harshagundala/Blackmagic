import type {
  PhysicalRoomValidationDeviceDiagnostic,
  PhysicalRoomValidationReport,
  PhysicalRoomValidationStatus,
} from "./physical-room-validation";

export type PhysicalRoomValidationSnapshot = {
  capturedAtMs: number;
  sessionKey: string;
  revision: number;
  validation: PhysicalRoomValidationReport;
};

export type PhysicalRoomValidationTraceOptions = {
  requiredReadyStreakMs?: number;
};

export type PhysicalRoomValidationTraceSummary = {
  status: PhysicalRoomValidationStatus | "empty";
  sampleCount: number;
  durationMs: number;
  firstReadyAtMs: number | null;
  timeToReadyMs: number | null;
  readyStreakMs: number;
  finalBlockers: string[];
  observedBlockers: string[];
  peakDeviceCount: number;
  peakLocalizedDeviceCount: number;
  peakRangeCount: number;
  peakAudioCaptureReadyDeviceCount: number;
  peakUnverifiedCaptureDeviceCount: number;
  peakFilteredCaptureDeviceCount: number;
  peakAudioTimestampReadyDeviceCount: number;
  worstAudioTimestampErrorMs: number | null;
  lowestAudioTimingConfidence: number | null;
  peakTdoaSourceCount: number;
  bestSourceResidualMs: number | null;
  devices: PhysicalRoomValidationDeviceTraceSummary[];
};

export type PhysicalRoomValidationDeviceTraceSummary = {
  deviceId: string;
  role: PhysicalRoomValidationDeviceDiagnostic["role"];
  sampleCount: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  finalBlockers: string[];
  observedBlockers: string[];
  finalLocalized: boolean;
  finalDistanceMeters: number | null;
  finalCaptureStatus: PhysicalRoomValidationDeviceDiagnostic["captureStatus"];
  finalAudioCaptureReady: boolean;
  finalAudioTimestampReady: boolean;
  worstAudioTimestampErrorMs: number | null;
  lowestAudioTimingConfidence: number | null;
  lowestMotionStability: number | null;
};

export function summarizePhysicalRoomValidationTrace(
  snapshots: PhysicalRoomValidationSnapshot[],
  { requiredReadyStreakMs = 0 }: PhysicalRoomValidationTraceOptions = {},
): PhysicalRoomValidationTraceSummary {
  const ordered = [...snapshots].sort(
    (a, b) => a.capturedAtMs - b.capturedAtMs || a.revision - b.revision,
  );
  if (ordered.length === 0) {
    return emptySummary();
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const firstReady = ordered.find(
    (snapshot) => snapshot.validation.status === "ready",
  );
  const readyStreakMs = trailingReadyStreakMs(ordered);
  const status =
    firstReady && readyStreakMs >= requiredReadyStreakMs
      ? "ready"
      : last.validation.status === "ready"
        ? "warming"
        : last.validation.status;

  return {
    status,
    sampleCount: ordered.length,
    durationMs: Math.max(0, last.capturedAtMs - first.capturedAtMs),
    firstReadyAtMs: firstReady?.capturedAtMs ?? null,
    timeToReadyMs: firstReady
      ? Math.max(0, firstReady.capturedAtMs - first.capturedAtMs)
      : null,
    readyStreakMs,
    finalBlockers: [...last.validation.blockers],
    observedBlockers: observedBlockers(ordered),
    peakDeviceCount: peakMetric(ordered, "deviceCount"),
    peakLocalizedDeviceCount: peakMetric(ordered, "localizedDeviceCount"),
    peakRangeCount: peakMetric(ordered, "rangeCount"),
    peakAudioCaptureReadyDeviceCount: peakMetric(
      ordered,
      "audioCaptureReadyDeviceCount",
    ),
    peakUnverifiedCaptureDeviceCount: peakMetric(
      ordered,
      "unverifiedCaptureDeviceCount",
    ),
    peakFilteredCaptureDeviceCount: peakMetric(
      ordered,
      "filteredCaptureDeviceCount",
    ),
    peakAudioTimestampReadyDeviceCount: peakMetric(
      ordered,
      "audioTimestampReadyDeviceCount",
    ),
    worstAudioTimestampErrorMs: worstAudioTimestampErrorMs(ordered),
    lowestAudioTimingConfidence: lowestAudioTimingConfidence(ordered),
    peakTdoaSourceCount: peakMetric(ordered, "tdoaSourceCount"),
    bestSourceResidualMs: bestSourceResidualMs(ordered),
    devices: summarizeDevices(ordered),
  };
}

function emptySummary(): PhysicalRoomValidationTraceSummary {
  return {
    status: "empty",
    sampleCount: 0,
    durationMs: 0,
    firstReadyAtMs: null,
    timeToReadyMs: null,
    readyStreakMs: 0,
    finalBlockers: [],
    observedBlockers: [],
    peakDeviceCount: 0,
    peakLocalizedDeviceCount: 0,
    peakRangeCount: 0,
    peakAudioCaptureReadyDeviceCount: 0,
    peakUnverifiedCaptureDeviceCount: 0,
    peakFilteredCaptureDeviceCount: 0,
    peakAudioTimestampReadyDeviceCount: 0,
    worstAudioTimestampErrorMs: null,
    lowestAudioTimingConfidence: null,
    peakTdoaSourceCount: 0,
    bestSourceResidualMs: null,
    devices: [],
  };
}

function summarizeDevices(
  snapshots: PhysicalRoomValidationSnapshot[],
): PhysicalRoomValidationDeviceTraceSummary[] {
  type DeviceAccumulator = {
    firstSeenAtMs: number;
    lastSeenAtMs: number;
    sampleCount: number;
    finalDevice: PhysicalRoomValidationDeviceDiagnostic;
    observedBlockers: string[];
    seenBlockers: Set<string>;
    audioTimestampErrors: number[];
    audioTimingConfidences: number[];
    motionStabilities: number[];
  };

  const devices = new Map<string, DeviceAccumulator>();

  for (const snapshot of snapshots) {
    for (const device of snapshot.validation.devices ?? []) {
      let entry = devices.get(device.deviceId);
      if (!entry) {
        entry = {
          firstSeenAtMs: snapshot.capturedAtMs,
          lastSeenAtMs: snapshot.capturedAtMs,
          sampleCount: 0,
          finalDevice: device,
          observedBlockers: [],
          seenBlockers: new Set<string>(),
          audioTimestampErrors: [],
          audioTimingConfidences: [],
          motionStabilities: [],
        };
        devices.set(device.deviceId, entry);
      }

      entry.lastSeenAtMs = snapshot.capturedAtMs;
      entry.sampleCount += 1;
      entry.finalDevice = device;

      for (const blocker of device.blockers) {
        if (!entry.seenBlockers.has(blocker)) {
          entry.seenBlockers.add(blocker);
          entry.observedBlockers.push(blocker);
        }
      }

      if (device.audioTimestampErrorMs !== null) {
        entry.audioTimestampErrors.push(device.audioTimestampErrorMs);
      }
      if (device.audioTimingConfidence !== null) {
        entry.audioTimingConfidences.push(device.audioTimingConfidence);
      }
      if (device.motionStability !== null) {
        entry.motionStabilities.push(device.motionStability);
      }
    }
  }

  return [...devices.entries()].map(([deviceId, entry]) => {
    const finalDevice = entry.finalDevice;
    return {
      deviceId,
      role: finalDevice.role,
      sampleCount: entry.sampleCount,
      firstSeenAtMs: entry.firstSeenAtMs,
      lastSeenAtMs: entry.lastSeenAtMs,
      finalBlockers: [...finalDevice.blockers],
      observedBlockers: entry.observedBlockers,
      finalLocalized: finalDevice.localized,
      finalDistanceMeters: finalDevice.distanceMeters,
      finalCaptureStatus: finalDevice.captureStatus,
      finalAudioCaptureReady: finalDevice.audioCaptureReady,
      finalAudioTimestampReady: finalDevice.audioTimestampReady,
      worstAudioTimestampErrorMs:
        entry.audioTimestampErrors.length === 0
          ? null
          : Math.max(...entry.audioTimestampErrors),
      lowestAudioTimingConfidence:
        entry.audioTimingConfidences.length === 0
          ? null
          : Math.min(...entry.audioTimingConfidences),
      lowestMotionStability:
        entry.motionStabilities.length === 0
          ? null
          : Math.min(...entry.motionStabilities),
    };
  });
}

function trailingReadyStreakMs(snapshots: PhysicalRoomValidationSnapshot[]) {
  let readySinceMs: number | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.validation.status !== "ready") {
      readySinceMs = null;
      continue;
    }
    readySinceMs ??= snapshot.capturedAtMs;
  }

  if (readySinceMs === null) {
    return 0;
  }

  return Math.max(0, snapshots[snapshots.length - 1].capturedAtMs - readySinceMs);
}

function observedBlockers(snapshots: PhysicalRoomValidationSnapshot[]) {
  const blockers: string[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    for (const blocker of snapshot.validation.blockers) {
      if (!seen.has(blocker)) {
        seen.add(blocker);
        blockers.push(blocker);
      }
    }
  }
  return blockers;
}

function peakMetric(
  snapshots: PhysicalRoomValidationSnapshot[],
  metric: keyof Pick<
    PhysicalRoomValidationReport["metrics"],
    | "deviceCount"
    | "localizedDeviceCount"
    | "rangeCount"
    | "audioCaptureReadyDeviceCount"
    | "unverifiedCaptureDeviceCount"
    | "filteredCaptureDeviceCount"
    | "audioTimestampReadyDeviceCount"
    | "tdoaSourceCount"
  >,
) {
  return Math.max(
    0,
    ...snapshots.map((snapshot) => snapshot.validation.metrics[metric]),
  );
}

function worstAudioTimestampErrorMs(
  snapshots: PhysicalRoomValidationSnapshot[],
) {
  const errors = snapshots
    .map((snapshot) => snapshot.validation.metrics.worstAudioTimestampErrorMs)
    .filter((value): value is number => value !== null);
  return errors.length === 0 ? null : Math.max(...errors);
}

function lowestAudioTimingConfidence(
  snapshots: PhysicalRoomValidationSnapshot[],
) {
  const confidences = snapshots
    .map((snapshot) => snapshot.validation.metrics.lowestAudioTimingConfidence)
    .filter((value): value is number => value !== null);
  return confidences.length === 0 ? null : Math.min(...confidences);
}

function bestSourceResidualMs(snapshots: PhysicalRoomValidationSnapshot[]) {
  const residuals = snapshots
    .map((snapshot) => snapshot.validation.metrics.bestSourceResidualMs)
    .filter((value): value is number => value !== null);
  return residuals.length === 0 ? null : Math.min(...residuals);
}
