// Every device chirps in its own frequency lane so simultaneous or adjacent
// chirps never confuse the matched filters. Lanes are exclusively
// near-ultrasonic (≥15.5 kHz): chirps must stay inaudible — loud is fine,
// audible is not — so there is deliberately NO audible fallback. The flip
// side, measured on ground-truth takes: a voice-processed capture records
// exactly nothing in this band, so chirp ranging requires the raw capture
// pipeline (the room auto-promotes to it) and a device that cannot capture
// the band simply contributes no chirp anchors while passive ranging keeps
// covering it.
// All lanes sit above 16.3 kHz: 15.5-16 kHz is still faintly audible to
// young ears, and ground-truth takes show even the top lane (17.75-18.4)
// detecting at 0.46-0.50 score on real phones, so the rolloff cost of
// starting higher is affordable.
export const ULTRASONIC_CHIRP_BANDS = [
  { frequencyHz: 16_300, endFrequencyHz: 16_900 },
  { frequencyHz: 16_900, endFrequencyHz: 17_500 },
  { frequencyHz: 17_500, endFrequencyHz: 18_100 },
  { frequencyHz: 18_100, endFrequencyHz: 18_700 },
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
