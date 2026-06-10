import type { AcousticRange } from "../session/ranging";
import { formatDistanceLabel } from "./phone-markers";

export type RangingProgressInput = {
  peerCount: number;
  // Chirps scheduled room-wide and chirp detections room-wide, from edge
  // evidence and/or polled room state.
  pulseCount: number;
  observationCount: number;
  ranges: AcousticRange[];
  // Devices the room currently considers chirp-capable (mic active with a
  // published audio frame) out of the devices present.
  emitterReadyCount?: number;
  deviceCount?: number;
  // Whether a WebRTC data channel to a peer is currently open.
  directLinkOpen?: boolean;
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
  emitterReadyCount,
  deviceCount,
  directLinkOpen,
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

  // Nothing has chirped yet: name the gate that is actually closed so a
  // stalled room is diagnosable from the phone screen. Chirp turns need at
  // least two devices with an active mic and a published audio frame.
  if (
    typeof emitterReadyCount === "number" &&
    typeof deviceCount === "number" &&
    emitterReadyCount < 2
  ) {
    return `mic clock ${emitterReadyCount}/${deviceCount}`;
  }

  if (directLinkOpen === false) {
    return "linking phones";
  }

  return "preparing chirps";
}
