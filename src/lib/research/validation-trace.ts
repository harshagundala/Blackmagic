import type {
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
  peakTdoaSourceCount: number;
  bestSourceResidualMs: number | null;
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
    peakTdoaSourceCount: peakMetric(ordered, "tdoaSourceCount"),
    bestSourceResidualMs: bestSourceResidualMs(ordered),
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
    peakTdoaSourceCount: 0,
    bestSourceResidualMs: null,
  };
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
    "deviceCount" | "localizedDeviceCount" | "rangeCount" | "tdoaSourceCount"
  >,
) {
  return Math.max(
    0,
    ...snapshots.map((snapshot) => snapshot.validation.metrics[metric]),
  );
}

function bestSourceResidualMs(snapshots: PhysicalRoomValidationSnapshot[]) {
  const residuals = snapshots
    .map((snapshot) => snapshot.validation.metrics.bestSourceResidualMs)
    .filter((value): value is number => value !== null);
  return residuals.length === 0 ? null : Math.min(...residuals);
}
