import { describe, expect, it } from "vitest";
import { ULTRASONIC_CHIRP_BAND, chirpBandFor } from "./chirp-lanes";

describe("chirpBandFor", () => {
  it("gives every device the full inaudible sweep band", () => {
    for (const id of ["a", "b", "device-1", "device-2"]) {
      expect(chirpBandFor(id)).toEqual(ULTRASONIC_CHIRP_BAND);
    }
  });

  it("stays above the audible speaker resonance — inaudible to humans", () => {
    // 18.5 kHz floor clears the ~16.5 kHz iPhone resonance that a young
    // listener could hear; the top stays under Nyquist for 48 kHz capture.
    expect(ULTRASONIC_CHIRP_BAND.frequencyHz).toBeGreaterThanOrEqual(18_500);
    expect(ULTRASONIC_CHIRP_BAND.endFrequencyHz).toBeLessThanOrEqual(21_000);
    expect(ULTRASONIC_CHIRP_BAND.endFrequencyHz).toBeGreaterThan(
      ULTRASONIC_CHIRP_BAND.frequencyHz,
    );
  });
});
