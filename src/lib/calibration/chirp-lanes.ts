// Chirps are exclusively near-ultrasonic: they must stay inaudible — loud is
// fine, audible is not — so there is deliberately NO audible fallback.
// Measured on ground-truth takes: a voice-processed capture records exactly
// nothing in this band, so chirp ranging requires the raw capture pipeline
// (the room auto-promotes to it), and a device that cannot capture the band
// simply contributes no chirp anchors while passive ranging keeps covering
// it.
//
// Band floor sits at 18.5 kHz, ABOVE the iPhone speaker's ~16.5 kHz
// resonance. Field measurement: that resonance radiates the 16.3-17 kHz part
// of the old sweep at ~63 dB SNR — loud enough that a young listener "clearly"
// heard it with the phone to her ear. 18.5 kHz is ~37 dB quieter (transducer
// rolloff) AND past the threshold of human hearing, so it is inaudible to
// essentially everyone while the speaker/mic still deliver it (18-22 dB raw
// SNR up to 21 kHz on an iPhone 17). The lower raw SNR up here is recovered
// by isolateChirpBand() + the matched filter (see scheduled-pulse-detector),
// which together also reject voice/noise — the band is speech-free, so the
// chirp survives even while people talk (the meeting-app requirement).
//
// Every device sweeps the SAME full band: the emitter rotation already
// separates devices in time (1.8 s slots), and matched-filter gain grows with
// bandwidth×duration.
export const ULTRASONIC_CHIRP_BAND = {
  frequencyHz: 18_500,
  endFrequencyHz: 20_500,
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
