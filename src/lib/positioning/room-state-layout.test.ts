import { describe, expect, test } from "vitest";
import {
  estimateRoomConstellation,
  fitAudioSourceByTdoa,
  rangeLayoutWeight,
} from "./room-state-layout";
import type { AcousticRange } from "@/lib/session/ranging";
import type { RoomState } from "@/lib/session/registry";
import type { RoomTimeSyncState } from "@/lib/session/timing-health";

describe("room state constellation", () => {
  test("uses acoustic ranges before falling back to radial placement", () => {
    const room: RoomState = {
      sessionKey: "room",
      hostDeviceId: "host",
      updatedAt: 10_000,
      devices: [
        {
          deviceId: "host",
          joinedAt: 1_000,
          lastSeenAt: 10_000,
          role: "host",
          sessionKey: "room",
        },
        {
          deviceId: "phone-a",
          joinedAt: 1_500,
          lastSeenAt: 10_000,
          role: "phone",
          sessionKey: "room",
        },
      ],
      ranges: [
        {
          from: "host",
          to: "phone-a",
          pulseId: "pulse-1",
          pulseIds: ["pulse-1"],
          samplesUsed: 1,
          meters: 2.4,
          timingUncertaintyMs: 1.2,
          distanceUncertaintyMeters: 0.41,
          confidence: 0.82,
          observedAtHostEpochMs: 10_006,
        },
      ],
    };

    const layout = estimateRoomConstellation(room);

    expect(layout.layout.points.host).toEqual({ x: 0, y: 0 });
    expect(layout.layout.quality).toBeGreaterThan(0.25);
    expect(layout.devices).toEqual([
      expect.objectContaining({ deviceId: "host", role: "host", x: 0, y: 0 }),
      expect.objectContaining({
        deviceId: "phone-a",
        role: "phone",
        distanceMeters: 2.4,
        confidence: 0.467,
      }),
    ]);
  });

  test("recenters device and source coordinates on the current phone", () => {
    const room: RoomState = {
      sessionKey: "room",
      hostDeviceId: "host",
      updatedAt: 20_000,
      devices: [
        {
          deviceId: "host",
          joinedAt: 1_000,
          lastSeenAt: 20_000,
          role: "host",
          sessionKey: "room",
        },
        {
          deviceId: "phone-a",
          joinedAt: 1_500,
          lastSeenAt: 20_000,
          role: "phone",
          sessionKey: "room",
        },
      ],
      ranges: [
        {
          from: "host",
          to: "phone-a",
          pulseId: "pulse-1",
          pulseIds: ["pulse-1"],
          samplesUsed: 5,
          meters: 2,
          timingUncertaintyMs: 1,
          distanceUncertaintyMeters: 0.2,
          confidence: 0.86,
          observedAtHostEpochMs: 20_000,
        },
      ],
      audioEvents: [
        {
          id: "voice:18000:host",
          startedAtHostEpochMs: 18_000,
          endedAtHostEpochMs: 18_008,
          centerHostEpochMs: 18_004,
          timeSpreadMs: 8,
          arrivalLeaderDeviceId: "host",
          observedDeviceIds: ["host", "phone-a"],
          observations: [
            {
              deviceId: "host",
              eventId: "voice-host",
              detectedAtHostEpochMs: 18_000,
              sampleIndex: 960_000,
              sampleRate: 48_000,
              audioLevel: 0.09,
              confidence: 0.86,
              clockUncertaintyMs: 3,
              timingConfidence: 0.82,
            },
            {
              deviceId: "phone-a",
              eventId: "voice-phone-a",
              detectedAtHostEpochMs: 18_008,
              sampleIndex: 960_384,
              sampleRate: 48_000,
              audioLevel: 0.07,
              confidence: 0.78,
              clockUncertaintyMs: 4,
              timingConfidence: 0.78,
            },
          ],
          timestampUncertaintyMs: 4,
          timingConfidence: 0.8,
          confidence: 0.76,
        },
      ],
    };

    const hostAnchored = estimateRoomConstellation(room);
    const selfAnchored = estimateRoomConstellation(room, {
      perspectiveDeviceId: "phone-a",
    });
    const self = selfAnchored.devices.find(
      (device) => device.deviceId === "phone-a",
    );
    const transformedHost = selfAnchored.devices.find(
      (device) => device.deviceId === "host",
    );
    const originalPhone = hostAnchored.devices.find(
      (device) => device.deviceId === "phone-a",
    );

    expect(self).toEqual(expect.objectContaining({ x: 0, y: 0 }));
    expect(transformedHost).toEqual(
      expect.objectContaining({
        x: expect.closeTo(-(originalPhone?.x ?? 0), 3),
        y: expect.closeTo(-(originalPhone?.y ?? 0), 3),
      }),
    );
    expect(selfAnchored.layout.points["phone-a"]).toEqual({ x: 0, y: 0 });
    expect(
      distance(selfAnchored.audioSources[0], hostAnchored.audioSources[0]),
    ).toBeGreaterThan(0.25);
    expect(distance(selfAnchored.audioSources[0], transformedHost)).toBeLessThan(
      distance(selfAnchored.audioSources[0], self),
    );
  });

  test("rotates self-centered coordinates by the current phone heading", () => {
    const room: RoomState = {
      sessionKey: "room",
      hostDeviceId: "host",
      updatedAt: 10_000,
      devices: [
        {
          deviceId: "host",
          joinedAt: 1_000,
          lastSeenAt: 10_000,
          role: "host",
          sessionKey: "room",
        },
        {
          deviceId: "phone-a",
          joinedAt: 1_500,
          lastSeenAt: 10_000,
          role: "phone",
          sessionKey: "room",
          headingDegrees: 90,
        },
        {
          deviceId: "phone-b",
          joinedAt: 1_600,
          lastSeenAt: 10_000,
          role: "phone",
          sessionKey: "room",
        },
      ],
      ranges: [],
    };

    const selfAnchored = estimateRoomConstellation(room, {
      perspectiveDeviceId: "phone-a",
    });

    expect(selfAnchored.devices).toEqual([
      expect.objectContaining({ deviceId: "host", x: 1.4, y: 0 }),
      expect.objectContaining({ deviceId: "phone-a", x: 0, y: 0 }),
      expect.objectContaining({ deviceId: "phone-b", x: 2.8, y: 0 }),
    ]);
  });

  test("weights repeated low-uncertainty ranges above one-shot uncertain ranges", () => {
    const stable = acousticRange({
      confidence: 0.7,
      distanceUncertaintyMeters: 0.2,
      samplesUsed: 5,
    });
    const oneShot = acousticRange({
      confidence: 0.82,
      distanceUncertaintyMeters: 1.8,
      samplesUsed: 1,
    });

    expect(rangeLayoutWeight(stable)).toBeGreaterThan(
      rangeLayoutWeight(oneShot),
    );
    expect(rangeLayoutWeight(oneShot)).toBeLessThan(0.45);
  });

  test("ignores acoustic ranges from devices that are not localization-ready", () => {
    const room: RoomState = {
      sessionKey: "room",
      hostDeviceId: "host",
      updatedAt: 30_000,
      devices: [
        {
          deviceId: "host",
          joinedAt: 1_000,
          lastSeenAt: 30_000,
          role: "host",
          sessionKey: "room",
        },
        {
          deviceId: "phone-a",
          joinedAt: 1_500,
          lastSeenAt: 30_000,
          role: "phone",
          sessionKey: "room",
        },
        {
          deviceId: "phone-b",
          joinedAt: 1_600,
          lastSeenAt: 30_000,
          role: "phone",
          sessionKey: "room",
        },
      ],
      timeSync: roomTimeSync({
        localizationDeviceIds: ["host", "phone-a"],
      }),
      ranges: [
        acousticRange({
          from: "host",
          to: "phone-a",
          meters: 2,
          confidence: 0.82,
          distanceUncertaintyMeters: 0.2,
        }),
        acousticRange({
          from: "host",
          to: "phone-b",
          meters: 5.8,
          confidence: 0.98,
          distanceUncertaintyMeters: 0.1,
        }),
      ],
    };

    const layout = estimateRoomConstellation(room);
    const phoneA = layout.devices.find((device) => device.deviceId === "phone-a");
    const phoneB = layout.devices.find((device) => device.deviceId === "phone-b");

    expect(phoneA).toEqual(
      expect.objectContaining({
        distanceMeters: 2,
      }),
    );
    expect(phoneB).toEqual(
      expect.objectContaining({
        distanceMeters: null,
      }),
    );
    expect(distance(layout.layout.points.host, layout.layout.points["phone-b"])).toBeLessThan(
      2.2,
    );
  });

  test("projects reconciled audio events toward the arrival leader side", () => {
    const room: RoomState = {
      sessionKey: "room",
      hostDeviceId: "host",
      updatedAt: 20_000,
      devices: [
        {
          deviceId: "host",
          joinedAt: 1_000,
          lastSeenAt: 20_000,
          role: "host",
          sessionKey: "room",
        },
        {
          deviceId: "phone-a",
          joinedAt: 1_500,
          lastSeenAt: 20_000,
          role: "phone",
          sessionKey: "room",
        },
      ],
      ranges: [
        {
          from: "host",
          to: "phone-a",
          pulseId: "pulse-1",
          pulseIds: ["pulse-1"],
          samplesUsed: 5,
          meters: 2,
          timingUncertaintyMs: 1,
          distanceUncertaintyMeters: 0.2,
          confidence: 0.86,
          observedAtHostEpochMs: 20_000,
        },
      ],
      audioEvents: [
        {
          id: "voice:18000:host",
          startedAtHostEpochMs: 18_000,
          endedAtHostEpochMs: 18_008,
          centerHostEpochMs: 18_004,
          timeSpreadMs: 8,
          arrivalLeaderDeviceId: "host",
          observedDeviceIds: ["host", "phone-a"],
          observations: [
            {
              deviceId: "host",
              eventId: "voice-host",
              detectedAtHostEpochMs: 18_000,
              sampleIndex: 960_000,
              sampleRate: 48_000,
              audioLevel: 0.09,
              confidence: 0.86,
              clockUncertaintyMs: 3,
              timingConfidence: 0.82,
            },
            {
              deviceId: "phone-a",
              eventId: "voice-phone-a",
              detectedAtHostEpochMs: 18_008,
              sampleIndex: 960_384,
              sampleRate: 48_000,
              audioLevel: 0.07,
              confidence: 0.78,
              clockUncertaintyMs: 4,
              timingConfidence: 0.78,
            },
          ],
          timestampUncertaintyMs: 4,
          timingConfidence: 0.8,
          confidence: 0.76,
        },
      ],
    };

    const constellation = estimateRoomConstellation(room);
    const source = constellation.audioSources[0];
    const host = constellation.devices.find((device) => device.deviceId === "host");
    const phone = constellation.devices.find(
      (device) => device.deviceId === "phone-a",
    );

    expect(source).toEqual(
      expect.objectContaining({
        eventId: "voice:18000:host",
        ageMs: 1_996,
        arrivalLeaderDeviceId: "host",
        observedDeviceIds: ["host", "phone-a"],
        timeSpreadMs: 8,
      }),
    );
    expect(source.confidence).toBeGreaterThan(0.6);
    expect(host).toBeDefined();
    expect(phone).toBeDefined();
    expect(distance(source, host)).toBeLessThan(distance(source, phone));
    expect(distance(source, phone)).toBeGreaterThan(distance(host, phone));
  });

  test("filters source hints to localization-ready device observations", () => {
    const devices = [
      constellationDevice({ deviceId: "host", role: "host", x: 0, y: 0 }),
      constellationDevice({ deviceId: "phone-a", x: 2, y: 0 }),
      constellationDevice({ deviceId: "phone-b", x: -2, y: 0 }),
    ];
    const event = voiceEventFromSource({
      devices,
      source: { x: -2.3, y: 0 },
      eventId: "voice:bad-clock-leader",
      emittedAtHostEpochMs: 80_000,
    });
    const room: RoomState = {
      sessionKey: "room",
      hostDeviceId: "host",
      updatedAt: 80_500,
      devices: [
        {
          deviceId: "host",
          joinedAt: 1_000,
          lastSeenAt: 80_500,
          role: "host",
          sessionKey: "room",
        },
        {
          deviceId: "phone-a",
          joinedAt: 1_500,
          lastSeenAt: 80_500,
          role: "phone",
          sessionKey: "room",
        },
        {
          deviceId: "phone-b",
          joinedAt: 1_600,
          lastSeenAt: 80_500,
          role: "phone",
          sessionKey: "room",
        },
      ],
      timeSync: roomTimeSync({
        localizationDeviceIds: ["host", "phone-a"],
      }),
      ranges: [
        acousticRange({
          from: "host",
          to: "phone-a",
          meters: 2,
          samplesUsed: 5,
          distanceUncertaintyMeters: 0.2,
          confidence: 0.86,
        }),
      ],
      audioEvents: [event],
    };

    const source = estimateRoomConstellation(room).audioSources[0];

    expect(source).toEqual(
      expect.objectContaining({
        method: "arrival-leader",
        arrivalLeaderDeviceId: "host",
        observedDeviceIds: ["host", "phone-a"],
      }),
    );
  });

  test("fits a source point from three-device time differences", () => {
    const devices = [
      constellationDevice({ deviceId: "host", role: "host", x: 0, y: 0 }),
      constellationDevice({ deviceId: "phone-a", x: 2, y: 0 }),
      constellationDevice({ deviceId: "phone-b", x: 0, y: 2 }),
    ];
    const actualSource = { x: -0.8, y: -0.55 };
    const event = voiceEventFromSource({
      devices,
      source: actualSource,
      eventId: "voice:tdoa",
      emittedAtHostEpochMs: 40_000,
    });

    const fit = fitAudioSourceByTdoa(event, devices, 40_500);

    expect(fit).toEqual(
      expect.objectContaining({
        eventId: "voice:tdoa",
        arrivalLeaderDeviceId: "host",
        method: "tdoa-grid",
        observedDeviceIds: ["host", "phone-b", "phone-a"],
      }),
    );
    expect(fit?.x).toBeCloseTo(actualSource.x, 1);
    expect(fit?.y).toBeCloseTo(actualSource.y, 1);
    expect(fit?.residualMs).toBeLessThan(1.5);
    expect(fit?.confidence).toBeGreaterThan(0.7);
  });

  test("downweights TDOA source hints when capture clocks are weak", () => {
    const devices = [
      constellationDevice({ deviceId: "host", role: "host", x: 0, y: 0 }),
      constellationDevice({ deviceId: "phone-a", x: 2, y: 0 }),
      constellationDevice({ deviceId: "phone-b", x: 0, y: 2 }),
    ];
    const strong = voiceEventFromSource({
      devices,
      source: { x: -0.55, y: -0.4 },
      eventId: "voice:strong-clock",
      emittedAtHostEpochMs: 50_000,
    });
    const weak = {
      ...strong,
      id: "voice:weak-clock",
      timingConfidence: 0.18,
      observations: strong.observations.map((observation) => ({
        ...observation,
        eventId: observation.eventId.replace("strong", "weak"),
        timingConfidence: 0.12,
      })),
    };

    const strongFit = fitAudioSourceByTdoa(strong, devices, 50_500);
    const weakFit = fitAudioSourceByTdoa(weak, devices, 50_500);

    expect(strongFit?.confidence).toBeGreaterThan(0.7);
    expect(weakFit?.confidence).toBeLessThan(
      (strongFit?.confidence ?? 0) - 0.2,
    );
  });

  test("downweights TDOA source hints when an observing phone is moving", () => {
    const devices = [
      constellationDevice({ deviceId: "host", role: "host", x: 0, y: 0 }),
      constellationDevice({ deviceId: "phone-a", x: 2, y: 0 }),
      constellationDevice({ deviceId: "phone-b", x: 0, y: 2 }),
    ];
    const stable = voiceEventFromSource({
      devices,
      source: { x: -0.35, y: -0.6 },
      eventId: "voice:stable-motion",
      emittedAtHostEpochMs: 60_000,
    });
    const moving = {
      ...stable,
      id: "voice:moving-motion",
      observations: stable.observations.map((observation) => ({
        ...observation,
        motionStability:
          observation.deviceId === "phone-a" ? 0.12 : observation.motionStability,
      })),
    };

    const stableFit = fitAudioSourceByTdoa(stable, devices, 60_500);
    const movingFit = fitAudioSourceByTdoa(moving, devices, 60_500);

    expect(stableFit?.confidence).toBeGreaterThan(0.7);
    expect(movingFit?.confidence).toBeLessThan(
      (stableFit?.confidence ?? 0) - 0.12,
    );
  });

  test("uses fingerprint-refined observation times for TDOA fitting", () => {
    const devices = [
      constellationDevice({ deviceId: "host", role: "host", x: 0, y: 0 }),
      constellationDevice({ deviceId: "phone-a", x: 2, y: 0 }),
      constellationDevice({ deviceId: "phone-b", x: 0, y: 2 }),
    ];
    const actualSource = { x: -0.8, y: -0.55 };
    const event = voiceEventFromSource({
      devices,
      source: actualSource,
      eventId: "voice:fingerprint-refined",
      emittedAtHostEpochMs: 70_000,
    });
    const rawCorrupted = {
      ...event,
      observations: event.observations.map((observation) =>
        observation.deviceId === "phone-a"
          ? {
              ...observation,
              detectedAtHostEpochMs: observation.detectedAtHostEpochMs + 18,
              refinedDetectedAtHostEpochMs: observation.detectedAtHostEpochMs,
              fingerprintCorrelation: 0.93,
              fingerprintOffsetMs:
                observation.detectedAtHostEpochMs -
                event.observations[0].detectedAtHostEpochMs,
            }
          : observation,
      ),
    };

    const fit = fitAudioSourceByTdoa(rawCorrupted, devices, 70_500);

    expect(fit?.x).toBeCloseTo(actualSource.x, 1);
    expect(fit?.y).toBeCloseTo(actualSource.y, 1);
    expect(fit?.residualMs).toBeLessThan(2);
  });
});

function acousticRange(
  overrides: Partial<AcousticRange> = {},
): AcousticRange {
  return {
    from: "host",
    to: "phone-a",
    pulseId: "pulse-1",
    pulseIds: ["pulse-1"],
    samplesUsed: 1,
    meters: 2.4,
    timingUncertaintyMs: 1.2,
    distanceUncertaintyMeters: 0.41,
    confidence: 0.82,
    observedAtHostEpochMs: 10_006,
    ...overrides,
  };
}

function distance(
  from: { x: number; y: number } | undefined,
  to: { x: number; y: number } | undefined,
) {
  if (!from || !to) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function constellationDevice(
  overrides: Partial<ReturnType<typeof estimateRoomConstellation>["devices"][number]> = {},
): ReturnType<typeof estimateRoomConstellation>["devices"][number] {
  return {
    deviceId: "phone",
    role: "phone",
    x: 0,
    y: 0,
    distanceMeters: null,
    confidence: 0.86,
    ...overrides,
  };
}

function voiceEventFromSource({
  devices,
  source,
  eventId,
  emittedAtHostEpochMs,
}: {
  devices: ReturnType<typeof estimateRoomConstellation>["devices"];
  source: { x: number; y: number };
  eventId: string;
  emittedAtHostEpochMs: number;
}) {
  const observations = devices
    .map((device) => {
      const travelMs =
        (Math.hypot(device.x - source.x, device.y - source.y) / 343) * 1_000;
      return {
        deviceId: device.deviceId,
        eventId: `${eventId}:${device.deviceId}`,
        detectedAtHostEpochMs: Number((emittedAtHostEpochMs + travelMs).toFixed(3)),
        sampleIndex: Math.round(960_000 + travelMs * 48),
        sampleRate: 48_000,
        audioLevel: 0.08,
        confidence: 0.9,
        clockUncertaintyMs: 1,
        clockQuality: 0.98,
        clockMaxErrorMs: 1.2,
        clockBestRoundTripMs: 3,
        clockJitterMs: 0.2,
        clockSamplesUsed: 10,
        clockOutliersRejected: 0,
        clockOffsetStabilityMs: 0.2,
        timingConfidence: 0.91,
        motionStability: 0.92,
      };
    })
    .sort((a, b) => a.detectedAtHostEpochMs - b.detectedAtHostEpochMs);

  return {
    id: eventId,
    startedAtHostEpochMs: observations[0].detectedAtHostEpochMs,
    endedAtHostEpochMs:
      observations[observations.length - 1].detectedAtHostEpochMs,
    centerHostEpochMs:
      observations.reduce(
        (total, observation) => total + observation.detectedAtHostEpochMs,
        0,
      ) / observations.length,
    timeSpreadMs:
      observations[observations.length - 1].detectedAtHostEpochMs -
      observations[0].detectedAtHostEpochMs,
    arrivalLeaderDeviceId: observations[0].deviceId,
    observedDeviceIds: observations.map((observation) => observation.deviceId),
    observations,
    timestampUncertaintyMs: 1,
    timingConfidence: 0.91,
    confidence: 0.86,
  };
}

function roomTimeSync(
  overrides: Partial<RoomTimeSyncState> = {},
): RoomTimeSyncState {
  return {
    status: "ready",
    synchronizedDeviceIds: ["host", "phone-a"],
    localizationDeviceIds: ["host", "phone-a"],
    roomConfidence: 0.8,
    medianMaxErrorMs: 4,
    worstLocalizationErrorMs: 5,
    devices: [
      {
        deviceId: "host",
        quality: 0.96,
        maxErrorMs: 4,
        uncertaintyMs: 3,
        bestRoundTripMs: 14,
        jitterMs: 0.8,
        offsetStabilityMs: 0.7,
        samplesUsed: 8,
        timingConfidence: 0.82,
        synchronized: true,
        localizationReady: true,
      },
      {
        deviceId: "phone-a",
        quality: 0.91,
        maxErrorMs: 5,
        uncertaintyMs: 4,
        bestRoundTripMs: 18,
        jitterMs: 1.2,
        offsetStabilityMs: 1,
        samplesUsed: 7,
        timingConfidence: 0.72,
        synchronized: true,
        localizationReady: true,
      },
      {
        deviceId: "phone-b",
        quality: 0.28,
        maxErrorMs: 80,
        uncertaintyMs: 55,
        bestRoundTripMs: 260,
        jitterMs: 18,
        offsetStabilityMs: 20,
        samplesUsed: 2,
        timingConfidence: 0.08,
        synchronized: false,
        localizationReady: false,
      },
    ],
    ...overrides,
  };
}
