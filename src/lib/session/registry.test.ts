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
        clockQuality: 0.92,
        clockMaxErrorMs: 7.2,
        clockBestRoundTripMs: 12,
        clockJitterMs: 1.2,
        clockSamplesUsed: 5,
        clockOutliersRejected: 1,
        clockOffsetStabilityMs: 0.9,
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
      voiceEvent: {
        id: "voice-phone-a",
        detectedAtHostEpochMs: 10_250,
        audioContextTimeSeconds: 10.2,
        sampleIndex: 489_600,
        sampleRate: 48_000,
        audioLevel: 0.08,
        confidence: 0.82,
        clockOffsetMs: 2,
        clockUncertaintyMs: 6,
        clockQuality: 0.92,
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
          clockQuality: 0.92,
          clockBestRoundTripMs: 12,
          clockSamplesUsed: 5,
          clockOutliersRejected: 1,
        }),
        voiceEvent: expect.objectContaining({
          id: "voice-phone-a",
          sampleIndex: 489_600,
          detectedAtHostEpochMs: 10_250,
        }),
      }),
    ]);
  });

  test("reconciles near-simultaneous voice events into room audio events", () => {
    const registry = createSessionRegistry({ now: () => 20_000 });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");
    registry.heartbeat("https://blackmagic.app/", "host", {
      voiceEvent: {
        id: "voice-host",
        detectedAtHostEpochMs: 18_000,
        audioContextTimeSeconds: 20,
        sampleIndex: 960_000,
        sampleRate: 48_000,
        audioLevel: 0.09,
        confidence: 0.85,
        clockOffsetMs: 1,
        clockUncertaintyMs: 3,
        clockQuality: 0.95,
      },
    });
    const state = registry.heartbeat("https://blackmagic.app/", "phone-a", {
      voiceEvent: {
        id: "voice-phone-a",
        detectedAtHostEpochMs: 18_008,
        audioContextTimeSeconds: 20.008,
        sampleIndex: 960_384,
        sampleRate: 48_000,
        audioLevel: 0.07,
        confidence: 0.78,
        clockOffsetMs: 2,
        clockUncertaintyMs: 4,
        clockQuality: 0.94,
      },
    });

    expect(state.audioEvents).toEqual([
      expect.objectContaining({
        arrivalLeaderDeviceId: "host",
        observedDeviceIds: ["host", "phone-a"],
        startedAtHostEpochMs: 18_000,
        endedAtHostEpochMs: 18_008,
      }),
    ]);
  });

  test("keeps bounded acoustic pulse and observation histories across heartbeats", () => {
    let now = 1_000;
    const registry = createSessionRegistry({ now: () => now });

    registry.claim("https://blackmagic.app/", "host");
    registry.claim("https://blackmagic.app/", "phone-a");

    for (let index = 0; index < 10; index += 1) {
      now += 100;
      registry.heartbeat("https://blackmagic.app/", "host", {
        acousticPulse: {
          id: `pulse-${index}`,
          emittedAtHostEpochMs: 10_000 + index * 1_000,
          durationMs: 48,
          frequencyHz: 17_200,
          endFrequencyHz: 19_200,
        },
      });
      registry.heartbeat("https://blackmagic.app/", "phone-a", {
        acousticObservation: {
          pulseId: `pulse-${index}`,
          detectedAtHostEpochMs: 10_006 + index * 1_000,
          amplitude: 0.3,
          confidence: 0.8,
          clockUncertaintyMs: 2,
        },
      });
    }

    const state = registry.state("https://blackmagic.app/");
    const host = state.devices.find((device) => device.deviceId === "host");
    const phone = state.devices.find((device) => device.deviceId === "phone-a");

    expect(host?.acousticPulses?.map((pulse) => pulse.id)).toEqual([
      "pulse-2",
      "pulse-3",
      "pulse-4",
      "pulse-5",
      "pulse-6",
      "pulse-7",
      "pulse-8",
      "pulse-9",
    ]);
    expect(phone?.acousticObservations?.map((observation) => observation.pulseId)).toEqual([
      "pulse-2",
      "pulse-3",
      "pulse-4",
      "pulse-5",
      "pulse-6",
      "pulse-7",
      "pulse-8",
      "pulse-9",
    ]);
    expect(state.ranges).toEqual([
      expect.objectContaining({
        from: "host",
        to: "phone-a",
        samplesUsed: 8,
        meters: 2.06,
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
