import { describe, expect, test } from "vitest";
import { roomSoundEnergy } from "./room-sound-energy";

describe("blackmagic room sound energy", () => {
  test("reacts to the loudest room microphone, not only the local phone", () => {
    expect(
      roomSoundEnergy({
        localMicLevel: 0.002,
        devices: [{ deviceId: "peer", micLevel: 0.055 }],
        audioSources: [],
      }),
    ).toBeGreaterThan(0.75);
  });

  test("keeps a recent reconciled voice source visible between heartbeats", () => {
    expect(
      roomSoundEnergy({
        localMicLevel: 0,
        devices: [],
        audioSources: [
          {
            eventId: "voice:host",
            confidence: 0.72,
            ageMs: 900,
          },
        ],
      }),
    ).toBeGreaterThan(0.45);
  });
});
