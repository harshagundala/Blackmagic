// Every device chirps in its own frequency lane so simultaneous or adjacent
// chirps never confuse the matched filters. Lanes are exclusively
// near-ultrasonic (≥15.5 kHz): chirps must stay inaudible — loud is fine,
// audible is not — so there is deliberately NO audible fallback. The flip
// side, measured on ground-truth takes: a voice-processed capture records
// exactly nothing in this band, so chirp ranging requires the raw capture
// pipeline (the room auto-promotes to it) and a device that cannot capture
// the band simply contributes no chirp anchors while passive ranging keeps
// covering it.
export const ULTRASONIC_CHIRP_BANDS = [
  { frequencyHz: 15_500, endFrequencyHz: 16_250 },
  { frequencyHz: 16_250, endFrequencyHz: 17_000 },
  { frequencyHz: 17_000, endFrequencyHz: 17_750 },
  { frequencyHz: 17_750, endFrequencyHz: 18_400 },
] as const;

// Phone speakers and mics roll off hard near-ultrasonic; the matched filter
// recovers the rest of the headroom, so the tone is driven hard.
export const ULTRASONIC_CHIRP_GAIN = 0.9;

// Below this capture rate the band sits beyond Nyquist and the device cannot
// see chirps at all (it still ranges passively).
export const MIN_ULTRASONIC_CAPTURE_RATE_HZ = 40_000;

export function chirpBandFor(deviceId: string) {
  let hash = 0;
  for (let index = 0; index < deviceId.length; index += 1) {
    hash = (hash * 31 + deviceId.charCodeAt(index)) | 0;
  }
  return ULTRASONIC_CHIRP_BANDS[Math.abs(hash) % ULTRASONIC_CHIRP_BANDS.length];
}
