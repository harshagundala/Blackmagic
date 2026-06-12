import { describe, expect, it } from "vitest";
import {
  AUDIBLE_CHIRP_BANDS,
  ULTRASONIC_CHIRP_BANDS,
  chirpBandFor,
  roomNeedsAudibleChirpLanes,
} from "./chirp-lanes";

const rawVerified = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  rawCaptureVerified: true,
};
const voiceProcessed = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  rawCaptureVerified: false,
};

describe("roomNeedsAudibleChirpLanes", () => {
  const rawDevice = { sampleRate: 48_000, captureProcessing: rawVerified };

  it("keeps ultrasonic lanes when every device captures raw and fast", () => {
    expect(
      roomNeedsAudibleChirpLanes({
        self: rawDevice,
        devices: [rawDevice, rawDevice],
      }),
    ).toBe(false);
  });

  it("drops to audible lanes when any device samples below the ultrasonic floor", () => {
    expect(
      roomNeedsAudibleChirpLanes({
        self: rawDevice,
        devices: [
          rawDevice,
          { sampleRate: 24_000, captureProcessing: rawVerified },
        ],
      }),
    ).toBe(true);
    expect(
      roomNeedsAudibleChirpLanes({
        self: { sampleRate: 24_000, captureProcessing: rawVerified },
        devices: [rawDevice],
      }),
    ).toBe(true);
  });

  it("drops to audible lanes when any device still runs voice processing", () => {
    // Voice processing (AEC/NS) attenuates the near-ultrasonic band even at
    // a 48 kHz capture rate, so sample rate alone must not pick the lanes.
    expect(
      roomNeedsAudibleChirpLanes({
        self: rawDevice,
        devices: [
          rawDevice,
          { sampleRate: 48_000, captureProcessing: voiceProcessed },
        ],
      }),
    ).toBe(true);
    expect(
      roomNeedsAudibleChirpLanes({
        self: { sampleRate: 48_000, captureProcessing: voiceProcessed },
        devices: [rawDevice],
      }),
    ).toBe(true);
  });

  it("treats an unreported processing state as voice-processed", () => {
    expect(
      roomNeedsAudibleChirpLanes({
        self: rawDevice,
        devices: [rawDevice, { sampleRate: 48_000, captureProcessing: null }],
      }),
    ).toBe(true);
  });

  it("ignores a missing sample rate (device not capturing yet)", () => {
    expect(
      roomNeedsAudibleChirpLanes({
        self: rawDevice,
        devices: [rawDevice, { sampleRate: null, captureProcessing: rawVerified }],
      }),
    ).toBe(false);
  });
});

describe("chirpBandFor", () => {
  it("assigns each device a deterministic lane from the requested family", () => {
    const ultrasonic = chirpBandFor("device-a", false);
    expect(ULTRASONIC_CHIRP_BANDS).toContainEqual(ultrasonic);
    expect(chirpBandFor("device-a", false)).toEqual(ultrasonic);

    const audible = chirpBandFor("device-a", true);
    expect(AUDIBLE_CHIRP_BANDS).toContainEqual(audible);
  });
});
