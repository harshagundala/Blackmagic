// Zero-phase high-pass for isolating the ultrasonic chirp band before
// matched-filter scoring. Speech and almost all environmental noise (voices,
// wind, traffic) live below ~10 kHz, so high-passing well below the chirp
// band removes that energy from the correlation's normalization. Without it,
// a loud room or people talking inflates the segment energy and crushes the
// detection score even though the chirp correlation itself is intact — the
// failure mode measured on a loud-outdoor field take, where detection
// collapsed from ~100% to ~40% and the phones never synced. A high-pass
// (rather than a band-pass) keeps the chirp band perfectly flat — a single
// resonant biquad cannot stay flat across the band near Nyquist — and zero
// phase (forward-backward) means the matched-filter peak is not shifted, so
// sub-sample ranging stays unbiased.

// One RBJ high-pass biquad at the given cutoff (Butterworth Q = 1/sqrt(2)).
function highpassBiquad(sampleRate: number, cutoffHz: number) {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2;
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosW0) / 2) / a0,
    b1: (-(1 + cosW0)) / a0,
    b2: ((1 + cosW0) / 2) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

function runBiquadForward(
  input: Float32Array,
  coeffs: ReturnType<typeof highpassBiquad>,
): Float32Array {
  const output = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < input.length; index += 1) {
    const x0 = input[index];
    const y0 =
      coeffs.b0 * x0 +
      coeffs.b1 * x1 +
      coeffs.b2 * x2 -
      coeffs.a1 * y1 -
      coeffs.a2 * y2;
    output[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

function reverse(input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = input[input.length - 1 - index];
  }
  return output;
}

// Strip sub-chirp-band energy (voice, wind, room noise) ahead of matched
// filtering. The cutoff sits a few kHz below the chirp's low edge so the band
// passes flat. Zero phase via forward-backward filtering (magnitude squared,
// 4th-order effective, no group delay).
export function isolateChirpBand(
  samples: Float32Array,
  sampleRate: number,
  chirpLowHz: number,
): Float32Array {
  if (samples.length === 0) {
    return samples;
  }
  const nyquist = sampleRate / 2;
  // No usable ultrasonic band on this capture rate (e.g. a 16 kHz voice
  // route): the chirp itself is beyond Nyquist, so leave the signal alone
  // and let callers fall back to the raw matched filter.
  if (chirpLowHz >= nyquist) {
    return samples;
  }
  // Comfortably below the chirp band but well above the voice band.
  const cutoffHz = Math.min(Math.max(8_000, chirpLowHz - 3_000), nyquist * 0.9);
  const coeffs = highpassBiquad(sampleRate, cutoffHz);
  const forward = runBiquadForward(samples, coeffs);
  const backward = runBiquadForward(reverse(forward), coeffs);
  return reverse(backward);
}
