import type { AcousticRange } from "../session/ranging";
import { formatDistanceLabel } from "./phone-markers";

export type RangingProgressInput = {
  peerCount: number;
  // Chirps scheduled room-wide and chirp detections room-wide, from edge
  // evidence and/or polled room state.
  pulseCount: number;
  observationCount: number;
  ranges: AcousticRange[];
};

// One honest line about where the localization pipeline currently is, so a
// stalled stage is visible on the phone instead of silently rendering
// nothing: chirps not firing, chirps firing but never heard, detections that
// fail to pair, or live links.
export function describeRangingProgress({
  peerCount,
  pulseCount,
  observationCount,
  ranges,
}: RangingProgressInput): string | null {
  if (peerCount === 0) {
    return null;
  }

  if (ranges.length > 0) {
    const nearest = [...ranges].sort((a, b) => a.meters - b.meters)[0];
    const label = formatDistanceLabel(nearest.meters);
    const links = `${ranges.length} ${ranges.length === 1 ? "link" : "links"}`;
    return label ? `${links} · ${label}` : links;
  }

  if (observationCount > 0) {
    return `chirps ${pulseCount} · heard ${observationCount} · solving`;
  }

  if (pulseCount > 0) {
    return `chirps ${pulseCount} · listening`;
  }

  return "preparing chirps";
}
