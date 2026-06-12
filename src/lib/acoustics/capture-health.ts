import type { CaptureConstraintMode } from "@/hooks/use-sensor-suite";

// A live microphone never reads near digital silence for seconds — even a
// quiet room has a noise floor well above 1e-4 RMS. Sustained sub-healthy
// readings from a "running" context mean the capture pipeline is broken: iOS
// sample-rate mismatch, a track muted by an interruption, or WebKit's
// "capture failure" states where the track silently never recovers.
//
// History: recovery originally fired only below 1e-5, then the ceiling moved
// to 3e-5 when a broken path was seen leaking faint processing noise — and a
// later device leaked ~5e-5, still deaf, still unrecovered. Thresholds keep
// losing to new leak levels, so there is deliberately NO dead zone anymore:
// everything below the healthy floor recovers, just on a longer fuse so a
// genuinely tomb-quiet stretch does not trigger churn. Any real sound — the
// room's chirp rotation alone guarantees one every few seconds — resets the
// fuse on a working capture.
export const SILENT_CAPTURE_RMS = 1e-5;
export const HEALTHY_CAPTURE_RMS = 1e-4;
export const SILENT_CAPTURE_REBUILD_MS = 3_000;
export const QUIET_CAPTURE_REBUILD_MS = 9_000;

// How long a running capture may sit at the given RMS before the recovery
// ladder fires; null means the level is healthy and no fuse should run.
export function captureRecoveryFuseMs(micLevel: number): number | null {
  if (micLevel >= HEALTHY_CAPTURE_RMS) {
    return null;
  }
  return micLevel <= SILENT_CAPTURE_RMS
    ? SILENT_CAPTURE_REBUILD_MS
    : QUIET_CAPTURE_REBUILD_MS;
}

// Chirp ranging needs voice processing off: echo cancellation deletes a
// phone's own chirp from its capture (no self-anchor, so no reciprocal
// range) and noise suppression attenuates the near-ultrasonic lanes. Once a
// multi-device room is live on a processed capture, it is worth one attempt
// at the raw pipeline — the silence watchdog demotes back to processed
// within seconds when raw capture is dead on the device, and a raw capture
// that proves healthy persists itself as the device's known-good mode.
export function shouldAutoPromoteRawCapture({
  mic,
  audioContextState,
  captureMode,
  rawCaptureVerified,
  roomDeviceCount,
}: {
  mic: "idle" | "active" | "blocked";
  audioContextState: AudioContextState | null;
  captureMode: CaptureConstraintMode | null;
  rawCaptureVerified: boolean;
  roomDeviceCount: number;
}): boolean {
  return (
    mic === "active" &&
    audioContextState === "running" &&
    captureMode === "processed" &&
    !rawCaptureVerified &&
    roomDeviceCount >= 2
  );
}
