import type { CaptureProcessingReport } from "@/lib/session/registry";

// Every device chirps in its own frequency lane so simultaneous or adjacent
// chirps never confuse the matched filters. Preferred lanes are
// near-ultrasonic (≥15.5 kHz — silent to most ears); they are only usable
// when every phone in the room both samples fast enough to represent them
// (a 24 kHz voice-processed capture has a 12 kHz Nyquist) AND captures raw:
// active voice processing (AEC/NS) attenuates the near-ultrasonic band even
// at a 48 kHz rate. Otherwise the room drops to sub-12 kHz lanes, played
// quietly since they are audible.
export const ULTRASONIC_CHIRP_BANDS = [
  { frequencyHz: 15_500, endFrequencyHz: 16_250 },
  { frequencyHz: 16_250, endFrequencyHz: 17_000 },
  { frequencyHz: 17_000, endFrequencyHz: 17_750 },
  { frequencyHz: 17_750, endFrequencyHz: 18_400 },
] as const;
export const AUDIBLE_CHIRP_BANDS = [
  { frequencyHz: 8_500, endFrequencyHz: 9_500 },
  { frequencyHz: 9_500, endFrequencyHz: 10_500 },
  { frequencyHz: 10_500, endFrequencyHz: 11_500 },
  { frequencyHz: 11_500, endFrequencyHz: 11_950 },
] as const;

export const LOW_CAPTURE_RATE_HZ = 40_000;

export type ChirpLaneDevice = {
  sampleRate?: number | null;
  captureProcessing?: CaptureProcessingReport | null;
};

export function chirpBandFor(deviceId: string, audible: boolean) {
  let hash = 0;
  for (let index = 0; index < deviceId.length; index += 1) {
    hash = (hash * 31 + deviceId.charCodeAt(index)) | 0;
  }
  const bands = audible ? AUDIBLE_CHIRP_BANDS : ULTRASONIC_CHIRP_BANDS;
  return bands[Math.abs(hash) % bands.length];
}

// True when any device in the room cannot see near-ultrasonic chirps —
// either its capture rate is too low or voice processing is (or may be)
// active. An unreported processing state counts as processed: guessing
// ultrasonic against an AEC/NS capture silently breaks ranging, while
// guessing audible merely makes the chirps faintly audible.
export function roomNeedsAudibleChirpLanes({
  self,
  devices,
}: {
  self: ChirpLaneDevice;
  devices: ChirpLaneDevice[];
}): boolean {
  return [self, ...devices].some(
    (device) =>
      (typeof device.sampleRate === "number" &&
        device.sampleRate < LOW_CAPTURE_RATE_HZ) ||
      device.captureProcessing?.rawCaptureVerified !== true,
  );
}
