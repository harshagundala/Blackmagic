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
      clockUncertaintyMs: 6,
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
        audioFrame: expect.objectContaining({
          sampleIndex: 480_000,
          hostEstimatedEpochMs: 1_700_000_002_002,
          clockUncertaintyMs: 6,
        }),
      }),
    ]);
  });

  test("prunes stale non-host phones but keeps the host anchor", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now, staleAfterMs: 5_000 });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");
    registry.heartbeat("https://blackmagic.app/", "phone-a", { micLevel: 0.1 });
    now = 8_000;

    const state = registry.state("https://blackmagic.app/");

    expect(state.devices.map((device) => device.deviceId)).toEqual(["host"]);
  });
});
