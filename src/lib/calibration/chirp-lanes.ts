// Chirps are exclusively near-ultrasonic: they must stay inaudible — loud is
// fine, audible is not — so there is deliberately NO audible fallback.
// Measured on ground-truth takes: a voice-processed capture records exactly
// nothing in this band, so chirp ranging requires the raw capture pipeline
// (the room auto-promotes to it), and a device that cannot capture the band
// simply contributes no chirp anchors while passive ranging keeps covering
// it.
//
// Every device sweeps the SAME full band: the emitter rotation already
// separates devices in time (1.8 s slots), and matched-filter gain grows
// with bandwidth×duration — the full 2.4 kHz sweep buys ~6 dB over the old
// per-device 600 Hz lanes plus a 4× sharper correlation peak, which is what
// makes room-scale (4 m+) receptions detectable. The band floor sits at
// 16.3 kHz because 15.5-16 kHz is still faintly audible to young ears;
// 4 m field takes show receptions detect fine all the way up to 18.7 kHz.
export const ULTRASONIC_CHIRP_BAND = {
  frequencyHz: 16_300,
  endFrequencyHz: 18_700,
} as const;

// Phone speakers and mics roll off hard near-ultrasonic; the matched filter
// recovers the rest of the headroom, so the tone is driven hard.
export const ULTRASONIC_CHIRP_GAIN = 0.9;

// Below this capture rate the band sits beyond Nyquist and the device cannot
// see chirps at all (it still ranges passively).
export const MIN_ULTRASONIC_CAPTURE_RATE_HZ = 40_000;

// Per-device parameter kept for call-site stability: every device sweeps the
// same full band today, but the signature leaves room to re-lane if a future
// room topology needs simultaneous emitters.
export function chirpBandFor(deviceId: string) {
  void deviceId;
  return ULTRASONIC_CHIRP_BAND;
}
