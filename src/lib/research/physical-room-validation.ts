import {
  estimateRoomConstellation,
  type RoomConstellation,
} from "../positioning/room-state-layout";
import type { RoomState } from "../session/registry";

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
  tdoaSourceCount: number;
  bestSourceResidualMs: number | null;
  bestSourceConfidence: number | null;
};

export type PhysicalRoomValidationReport = {
  status: PhysicalRoomValidationStatus;
  phoneLayout: PhysicalRoomValidationSection;
  spokenSource: PhysicalRoomValidationSection;
  metrics: PhysicalRoomValidationMetrics;
  blockers: string[];
};

const MAX_READY_LAYOUT_STRESS_METERS = 0.35;
const MAX_READY_SOURCE_RESIDUAL_MS = 5;
const MIN_READY_SOURCE_CONFIDENCE = 0.35;

export function validatePhysicalRoomLocalization(
  roomState: RoomState,
  constellation: RoomConstellation = estimateRoomConstellation(roomState),
): PhysicalRoomValidationReport {
  const metrics = validationMetrics(roomState, constellation);
  const phoneLayout = phoneLayoutSection(metrics);
  const spokenSource = spokenSourceSection(metrics);
  const sections = [phoneLayout, spokenSource];
  const blockers = unique([
    ...phoneLayout.blockers,
    ...spokenSource.blockers,
  ]);

  return {
    status: aggregateStatus(sections),
    phoneLayout,
    spokenSource,
    metrics,
    blockers,
  };
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

  return {
    deviceCount: roomState.devices.length,
    localizedDeviceCount: constellation.devices.filter((device) => device.localized)
      .length,
    rangeCount: roomState.ranges.length,
    layoutStressMeters: round(constellation.layout.stress),
    clockStatus: roomState.timeSync.status,
    worstClockErrorMs: roomState.timeSync.worstLocalizationErrorMs,
    roomClockConfidence: roomState.timeSync.roomConfidence,
    tdoaSourceCount: tdoaSources.length,
    bestSourceResidualMs:
      sourceResiduals.length === 0 ? null : round(Math.min(...sourceResiduals)),
    bestSourceConfidence:
      sourceConfidences.length === 0
        ? null
        : round(Math.max(...sourceConfidences)),
  };
}

function phoneLayoutSection(
  metrics: PhysicalRoomValidationMetrics,
): PhysicalRoomValidationSection {
  const blockers: string[] = [];
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
  }

  return {
    status: blockers.length === 0 ? "ready" : "warming",
    blockers,
  };
}

function spokenSourceSection(
  metrics: PhysicalRoomValidationMetrics,
): PhysicalRoomValidationSection {
  const blockers: string[] = [];
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
  }
  if (
    metrics.bestSourceConfidence !== null &&
    metrics.bestSourceConfidence < MIN_READY_SOURCE_CONFIDENCE
  ) {
    blockers.push("source_confidence_low");
  }

  return {
    status: blockers.length === 0 ? "ready" : "warming",
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

function round(value: number) {
  return Number(value.toFixed(3));
}
