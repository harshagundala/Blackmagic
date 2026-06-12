import { describe, expect, it } from "vitest";
import { ULTRASONIC_CHIRP_BANDS, chirpBandFor } from "./chirp-lanes";

describe("chirpBandFor", () => {
  it("assigns each device a deterministic near-ultrasonic lane", () => {
    const band = chirpBandFor("device-a");
    expect(ULTRASONIC_CHIRP_BANDS).toContainEqual(band);
    expect(chirpBandFor("device-a")).toEqual(band);
  });

  it("only ever assigns inaudible lanes — there is no audible fallback", () => {
    for (const id of ["a", "b", "c", "d", "e", "device-1", "device-2"]) {
      expect(chirpBandFor(id).frequencyHz).toBeGreaterThanOrEqual(15_500);
    }
  });
});
