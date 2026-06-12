import { describe, expect, it } from "vitest";
import { ULTRASONIC_CHIRP_BAND, chirpBandFor } from "./chirp-lanes";

describe("chirpBandFor", () => {
  it("gives every device the full inaudible sweep band", () => {
    for (const id of ["a", "b", "device-1", "device-2"]) {
      expect(chirpBandFor(id)).toEqual(ULTRASONIC_CHIRP_BAND);
    }
  });

  it("never assigns audible frequencies — there is no audible fallback", () => {
    expect(ULTRASONIC_CHIRP_BAND.frequencyHz).toBeGreaterThanOrEqual(16_300);
    expect(ULTRASONIC_CHIRP_BAND.endFrequencyHz).toBeGreaterThan(
      ULTRASONIC_CHIRP_BAND.frequencyHz,
    );
  });
});
