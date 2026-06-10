import type {
  PhysicalRoomValidationDeviceDiagnostic,
  PhysicalRoomValidationReport,
  PhysicalRoomValidationStatus,
} from "./physical-room-validation";

export type PhysicalRoomValidationSnapshot = {
  capturedAtMs: number;
  sessionKey: string;
  revision: number;
  updatedAt?: number;
  validation: PhysicalRoomValidationReport;
};

export type PhysicalRoomValidationTraceOptions = {
  minDevices?: number;
  requiredReadyStreakMs?: number;
  requireTdoaSource?: boolean;
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

export type PhysicalRoomTrialEvidenceOptions = {
  baseUrl: string;
  generatedAtMs: number;
  minDevices?: number;
  requiredReadyStreakMs?: number;
  requireTdoaSource?: boolean;
  sessionUrl: string;
  snapshots: PhysicalRoomValidationSnapshot[];
};

export type PhysicalRoomTrialEvidenceGateId =
  | "sustained_ready"
  | "minimum_devices"
  | "localized_devices"
  | "acoustic_ranges"
  | "audio_capture"
  | "audio_timestamps"
  | "tdoa_source";

export type PhysicalRoomTrialEvidenceGate = {
  id: PhysicalRoomTrialEvidenceGateId;
  passed: boolean;
  observed: number;
  required: number;
};

export type PhysicalRoomTrialEvidenceNextAction = {
  id: string;
  priority: number;
  title: string;
  detail: string;
  gates: PhysicalRoomTrialEvidenceGateId[];
  blockers: string[];
  deviceIds: string[];
};

export type PhysicalRoomTrialEvidence = {
  protocolVersion: 1;
  generatedAtMs: number;
  baseUrl: string;
  sessionUrl: string;
  sessionKey: string | null;
  minDevices: number;
  requiredReadyStreakMs: number;
  requireTdoaSource: boolean;
  passed: boolean;
  sampleWindow: {
    firstCapturedAtMs: number | null;
    lastCapturedAtMs: number | null;
    durationMs: number;
    sampleCount: number;
  };
  gates: PhysicalRoomTrialEvidenceGate[];
  failedGateIds: PhysicalRoomTrialEvidenceGateId[];
  nextActions: PhysicalRoomTrialEvidenceNextAction[];
  summary: PhysicalRoomValidationTraceSummary;
  finalSnapshot: {
    capturedAtMs: number | null;
    revision: number | null;
    updatedAtMs: number | null;
    status: PhysicalRoomValidationStatus | "empty";
    blockers: string[];
    metrics: PhysicalRoomValidationReport["metrics"] | null;
    devices: PhysicalRoomValidationDeviceDiagnostic[];
  };
};

const DEFAULT_TRIAL_MIN_DEVICES = 3;
const TDOA_BLOCKERS = new Set([
  "insufficient_tdoa_devices",
  "no_tdoa_source",
  "source_residual_high",
  "source_confidence_low",
]);

export function createPhysicalRoomTrialEvidence({
  baseUrl,
  generatedAtMs,
  minDevices = DEFAULT_TRIAL_MIN_DEVICES,
  requiredReadyStreakMs = 0,
  requireTdoaSource,
  sessionUrl,
  snapshots,
}: PhysicalRoomTrialEvidenceOptions): PhysicalRoomTrialEvidence {
  const profile = trialProfile({ minDevices, requireTdoaSource });
  const ordered = [...snapshots].sort(
    (a, b) => a.capturedAtMs - b.capturedAtMs || a.revision - b.revision,
  );
  const summary = summarizePhysicalRoomValidationTrace(ordered, {
    minDevices: profile.minDevices,
    requiredReadyStreakMs,
    requireTdoaSource: profile.requireTdoaSource,
  });
  const first = ordered[0] ?? null;
  const final = ordered[ordered.length - 1] ?? null;
  const finalMetrics = final?.validation.metrics ?? null;
  const finalDeviceCount = finalMetrics?.deviceCount ?? 0;
  const requiredDevices = profile.minDevices;
  const requiredRanges = requiredAcousticRanges({
    deviceCount: finalDeviceCount,
    minDevices: requiredDevices,
    requireTdoaSource: profile.requireTdoaSource,
  });
  const requiredDeviceEvidence = requiredEvidenceDevices({
    deviceCount: finalDeviceCount,
    minDevices: requiredDevices,
  });
  const gates: PhysicalRoomTrialEvidenceGate[] = [
    {
      id: "sustained_ready",
      passed: summary.status === "ready",
      observed: summary.readyStreakMs,
      required: requiredReadyStreakMs,
    },
    {
      id: "minimum_devices",
      passed: summary.peakDeviceCount >= requiredDevices,
      observed: summary.peakDeviceCount,
      required: requiredDevices,
    },
    {
      id: "localized_devices",
      passed: summary.peakLocalizedDeviceCount >= requiredDevices,
      observed: summary.peakLocalizedDeviceCount,
      required: requiredDevices,
    },
    {
      id: "acoustic_ranges",
      passed: summary.peakRangeCount >= requiredRanges,
      observed: summary.peakRangeCount,
      required: requiredRanges,
    },
    {
      id: "audio_capture",
      passed:
        summary.peakAudioCaptureReadyDeviceCount >= requiredDeviceEvidence,
      observed: summary.peakAudioCaptureReadyDeviceCount,
      required: requiredDeviceEvidence,
    },
    {
      id: "audio_timestamps",
      passed:
        summary.peakAudioTimestampReadyDeviceCount >= requiredDeviceEvidence,
      observed: summary.peakAudioTimestampReadyDeviceCount,
      required: requiredDeviceEvidence,
    },
  ];
  if (profile.requireTdoaSource) {
    gates.push({
      id: "tdoa_source",
      passed: summary.peakTdoaSourceCount >= 1,
      observed: summary.peakTdoaSourceCount,
      required: 1,
    });
  }
  const failedGateIds = gates
    .filter((gate) => !gate.passed)
    .map((gate) => gate.id);

  return {
    protocolVersion: 1,
    generatedAtMs,
    baseUrl,
    sessionUrl,
    sessionKey: final?.sessionKey ?? first?.sessionKey ?? null,
    minDevices: profile.minDevices,
    requiredReadyStreakMs,
    requireTdoaSource: profile.requireTdoaSource,
    passed: gates.every((gate) => gate.passed),
    sampleWindow: {
      firstCapturedAtMs: first?.capturedAtMs ?? null,
      lastCapturedAtMs: final?.capturedAtMs ?? null,
      durationMs: summary.durationMs,
      sampleCount: summary.sampleCount,
    },
    gates,
    failedGateIds,
    nextActions: createNextActions({
      failedGateIds,
      minDevices: profile.minDevices,
      summary,
    }),
    summary,
    finalSnapshot: {
      capturedAtMs: final?.capturedAtMs ?? null,
      revision: final?.revision ?? null,
      updatedAtMs: final?.updatedAt ?? null,
      status: final?.validation.status ?? "empty",
      blockers: final ? [...final.validation.blockers] : [],
      metrics: finalMetrics,
      devices: final ? [...(final.validation.devices ?? [])] : [],
    },
  };
}

function createNextActions({
  failedGateIds,
  minDevices,
  summary,
}: {
  failedGateIds: PhysicalRoomTrialEvidenceGateId[];
  minDevices: number;
  summary: PhysicalRoomValidationTraceSummary;
}): PhysicalRoomTrialEvidenceNextAction[] {
  const failed = new Set(failedGateIds);
  const actions: PhysicalRoomTrialEvidenceNextAction[] = [];
  const blockerSet = new Set([
    ...summary.finalBlockers,
    ...summary.observedBlockers,
  ]);

  if (failed.has("minimum_devices")) {
    actions.push({
      id: "connect_more_phones",
      priority: 10,
      title: `Connect at least ${minDevices} phones to this session URL.`,
      detail: `Only ${summary.peakDeviceCount} phone(s) appeared in the trace; this trial needs at least ${minDevices} active devices.`,
      gates: ["minimum_devices"],
      blockers: relatedBlockers(blockerSet, ["insufficient_devices"]),
      deviceIds: [],
    });
  }

  if (failed.has("audio_capture")) {
    const deviceIds = devicesMatching(summary, (device) => {
      return !device.finalAudioCaptureReady;
    });
    actions.push({
      id: "enable_microphone_capture",
      priority: 20,
      title: "Get every phone to verified raw microphone capture.",
      detail:
        "Tap the page on each phone, allow microphone access, keep Safari in the foreground, and confirm no device reports filtered or missing capture.",
      gates: ["audio_capture"],
      blockers: relatedBlockers(blockerSet, [
        "insufficient_audio_capture",
        "audio_capture_missing",
        "audio_capture_unverified",
        "filtered_audio_capture",
        "audio_context_not_running",
        "mic_not_active",
      ]),
      deviceIds,
    });
  }

  if (failed.has("audio_timestamps")) {
    const deviceIds = devicesMatching(summary, (device) => {
      return !device.finalAudioTimestampReady;
    });
    actions.push({
      id: "stabilize_audio_timestamps",
      priority: 30,
      title: "Wait for precise audio timestamps on every phone.",
      detail:
        "Keep phones awake and still while clock sync, audio-frame anchors, and timing confidence settle before judging localization.",
      gates: ["audio_timestamps"],
      blockers: relatedBlockers(blockerSet, [
        "insufficient_audio_timestamps",
        "audio_timestamp_missing",
        "audio_timestamp_error_high",
        "audio_timestamp_confidence_low",
        "audio_timestamps_not_ready",
        "clock_not_ready",
      ]),
      deviceIds,
    });
  }

  const needsCalibration =
    failed.has("localized_devices") || failed.has("acoustic_ranges");
  if (needsCalibration) {
    actions.push({
      id: "complete_acoustic_calibration",
      priority: 40,
      title: "Let reciprocal chirp calibration finish with phones still.",
      detail:
        "Keep the devices unmuted and separated in the room until the trace shows enough sample-anchored acoustic ranges and localized phones.",
      gates: failedGateIds.filter(
        (gate) => gate === "localized_devices" || gate === "acoustic_ranges",
      ),
      blockers: relatedBlockers(blockerSet, [
        "insufficient_acoustic_ranges",
        "insufficient_localized_devices",
        "layout_stress_high",
        "not_localized",
      ]),
      deviceIds: devicesMatching(summary, (device) => !device.finalLocalized),
    });
  }

  if (failed.has("tdoa_source")) {
    actions.push({
      id: "capture_spoken_source",
      priority: 50,
      title: "Capture one clear spoken source after phones are localized.",
      detail:
        "Have one person speak for a few seconds near the phones so the TDOA fitter can compare arrival times across at least three devices.",
      gates: ["tdoa_source"],
      blockers: relatedBlockers(blockerSet, [
        "insufficient_tdoa_devices",
        "no_tdoa_source",
        "source_residual_high",
        "source_confidence_low",
      ]),
      deviceIds: [],
    });
  }

  if (failed.has("sustained_ready")) {
    actions.push({
      id: "hold_ready_state",
      priority: 60,
      title: "Keep the room ready for the required sustained window.",
      detail: `The trace only held ready for ${summary.readyStreakMs} ms; keep all phones open until the sustained-ready gate is satisfied.`,
      gates: ["sustained_ready"],
      blockers: [...summary.finalBlockers],
      deviceIds: [],
    });
  }

  return actions.sort((left, right) => left.priority - right.priority);
}

function relatedBlockers(blockers: Set<string>, candidates: string[]) {
  return candidates.filter((blocker) => blockers.has(blocker));
}

function devicesMatching(
  summary: PhysicalRoomValidationTraceSummary,
  predicate: (device: PhysicalRoomValidationDeviceTraceSummary) => boolean,
) {
  return summary.devices
    .filter(predicate)
    .map((device) => device.deviceId)
    .sort();
}

type TrialProfile = {
  minDevices: number;
  requireTdoaSource: boolean;
};

function trialProfile({
  minDevices,
  requireTdoaSource,
}: {
  minDevices: number;
  requireTdoaSource?: boolean;
}): TrialProfile {
  if (!Number.isFinite(minDevices) || minDevices < 2) {
    throw new Error("minDevices must be at least 2");
  }

  const normalizedMinDevices = Math.floor(minDevices);
  return {
    minDevices: normalizedMinDevices,
    requireTdoaSource: requireTdoaSource ?? normalizedMinDevices >= 3,
  };
}

function requiredEvidenceDevices({
  deviceCount,
  minDevices,
}: {
  deviceCount: number;
  minDevices: number;
}) {
  return Math.max(minDevices, deviceCount);
}

function requiredAcousticRanges({
  deviceCount,
  minDevices,
  requireTdoaSource,
}: {
  deviceCount: number;
  minDevices: number;
  requireTdoaSource: boolean;
}) {
  if (!requireTdoaSource) {
    return Math.max(1, minDevices - 1);
  }

  return deviceCount >= 3 ? Math.max(3, deviceCount) : minDevices;
}

function isTrialReadySnapshot(
  snapshot: PhysicalRoomValidationSnapshot,
  profile: TrialProfile,
) {
  if (profile.requireTdoaSource) {
    return snapshot.validation.status === "ready";
  }

  const metrics = snapshot.validation.metrics;
  const requiredDevices = requiredEvidenceDevices({
    deviceCount: metrics.deviceCount,
    minDevices: profile.minDevices,
  });
  const requiredRanges = requiredAcousticRanges({
    deviceCount: metrics.deviceCount,
    minDevices: profile.minDevices,
    requireTdoaSource: profile.requireTdoaSource,
  });

  return (
    snapshot.validation.phoneLayout.status === "ready" &&
    snapshot.validation.audioCapture.status === "ready" &&
    snapshot.validation.audioTimestamps.status === "ready" &&
    metrics.deviceCount >= profile.minDevices &&
    metrics.localizedDeviceCount >= profile.minDevices &&
    metrics.rangeCount >= requiredRanges &&
    metrics.audioCaptureReadyDeviceCount >= requiredDevices &&
    metrics.audioTimestampReadyDeviceCount >= requiredDevices
  );
}

function trialBlockers(
  snapshot: PhysicalRoomValidationSnapshot,
  profile: TrialProfile,
) {
  if (profile.requireTdoaSource) {
    return [...snapshot.validation.blockers];
  }

  return snapshot.validation.blockers.filter(
    (blocker) => !TDOA_BLOCKERS.has(blocker),
  );
}

export function summarizePhysicalRoomValidationTrace(
  snapshots: PhysicalRoomValidationSnapshot[],
  {
    minDevices = DEFAULT_TRIAL_MIN_DEVICES,
    requiredReadyStreakMs = 0,
    requireTdoaSource,
  }: PhysicalRoomValidationTraceOptions = {},
): PhysicalRoomValidationTraceSummary {
  const profile = trialProfile({ minDevices, requireTdoaSource });
  const ordered = [...snapshots].sort(
    (a, b) => a.capturedAtMs - b.capturedAtMs || a.revision - b.revision,
  );
  if (ordered.length === 0) {
    return emptySummary();
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const firstReady = ordered.find((snapshot) =>
    isTrialReadySnapshot(snapshot, profile),
  );
  const readyStreakMs = trailingReadyStreakMs(ordered, profile);
  const status =
    firstReady && readyStreakMs >= requiredReadyStreakMs
      ? "ready"
      : isTrialReadySnapshot(last, profile)
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
    finalBlockers: trialBlockers(last, profile),
    observedBlockers: observedBlockers(ordered, profile),
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

function trailingReadyStreakMs(
  snapshots: PhysicalRoomValidationSnapshot[],
  profile: TrialProfile,
) {
  let readySinceMs: number | null = null;
  for (const snapshot of snapshots) {
    if (!isTrialReadySnapshot(snapshot, profile)) {
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

function observedBlockers(
  snapshots: PhysicalRoomValidationSnapshot[],
  profile: TrialProfile,
) {
  const blockers: string[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    for (const blocker of trialBlockers(snapshot, profile)) {
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
