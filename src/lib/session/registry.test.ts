import { describe, expect, test } from "vitest";
import { createSessionRegistry } from "./registry";

describe("session registry", () => {
  test("makes the first device at a URL the host", () => {
    const registry = createSessionRegistry();

    expect(registry.claim("https://blackmagic.app/", "a").role).toBe("host");
    expect(registry.claim("https://blackmagic.app/", "b").role).toBe("phone");
    expect(registry.claim("https://blackmagic.app/", "a").role).toBe("host");
  });

  test("keeps different URLs isolated", () => {
    const registry = createSessionRegistry();

    expect(registry.claim("https://blackmagic.app/", "a").role).toBe("host");
    expect(registry.claim("https://blackmagic.app/alpha", "b").role).toBe("host");
  });

  test("tracks active device heartbeats with sensor and timing summaries", () => {
    const registry = createSessionRegistry({ now: () => 10_000 });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");
    const state = registry.heartbeat("https://blackmagic.app/", "phone-a", {
      mic: "active",
      micLevel: 0.08,
      sampleRate: 48_000,
      clockQuality: 0.92,
      clockOffsetMs: -3.5,
      clockUncertaintyMs: 6,
      clockMaxErrorMs: 7.2,
      clockBestRoundTripMs: 12,
      clockJitterMs: 1.2,
      clockSamplesUsed: 5,
      audioFrame: {
        audioContextTimeSeconds: 10,
        sampleIndex: 480_000,
        sampleRate: 48_000,
        clientPerfOriginEpochMs: 1_700_000_000_000,
        performanceNowMs: 2_000,
        clockOffsetMs: 2,
        clockUncertaintyMs: 6,
        audioElapsedMs: 10_000,
        hostEstimatedEpochMs: 1_700_000_002_002,
      },
      motion: "active",
      heading: "idle",
      location: "blocked",
      acousticPulse: {
        id: "chirp-1",
        emittedAtHostEpochMs: 10_500,
        durationMs: 48,
        frequencyHz: 17_200,
        endFrequencyHz: 19_200,
      },
    });

    expect(state.devices).toEqual([
      expect.objectContaining({ deviceId: "host", role: "host" }),
      expect.objectContaining({
        deviceId: "phone-a",
        role: "phone",
        mic: "active",
        micLevel: 0.08,
        sampleRate: 48_000,
        clockQuality: 0.92,
        clockOffsetMs: -3.5,
        clockMaxErrorMs: 7.2,
        clockBestRoundTripMs: 12,
        clockJitterMs: 1.2,
        clockSamplesUsed: 5,
        acousticPulse: expect.objectContaining({
          id: "chirp-1",
          frequencyHz: 17_200,
          endFrequencyHz: 19_200,
        }),
        audioFrame: expect.objectContaining({
          sampleIndex: 480_000,
          hostEstimatedEpochMs: 1_700_000_002_002,
          clockUncertaintyMs: 6,
        }),
      }),
    ]);
  });

  test("prunes stale non-host phones while keeping an active host", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now, staleAfterMs: 5_000 });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");
    registry.heartbeat("https://blackmagic.app/", "phone-a", { micLevel: 0.1 });
    now = 4_000;
    registry.heartbeat("https://blackmagic.app/", "host", { micLevel: 0.1 });
    now = 8_000;

    const state = registry.state("https://blackmagic.app/");

    expect(state.devices.map((device) => device.deviceId)).toEqual(["host"]);
  });

  test("releases a stale host so the next active device becomes host", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now, staleAfterMs: 5_000 });

    registry.claim("https://blackmagic.app/", "host");
    now = 8_000;

    expect(registry.claim("https://blackmagic.app/", "next").role).toBe("host");
    expect(registry.state("https://blackmagic.app/")).toEqual(
      expect.objectContaining({
        hostDeviceId: "next",
        devices: [expect.objectContaining({ deviceId: "next", role: "host" })],
      }),
    );
  });

  test("promotes the oldest active phone when the host goes stale", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now, staleAfterMs: 5_000 });

    registry.claim("https://blackmagic.app/", "host");
    now = 2_000;
    registry.claim("https://blackmagic.app/", "phone-a");
    now = 7_000;
    registry.heartbeat("https://blackmagic.app/", "phone-a", { micLevel: 0.1 });
    now = 8_000;

    const state = registry.state("https://blackmagic.app/");

    expect(state.hostDeviceId).toBe("phone-a");
    expect(state.devices).toEqual([
      expect.objectContaining({ deviceId: "phone-a", role: "host" }),
    ]);
  });
});
