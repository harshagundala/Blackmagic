import { describe, expect, test } from "vitest";
import { deriveAcousticRanges } from "./ranging";
import type {
  AcousticObservation,
  AcousticPulse,
  RoomDevice,
} from "./registry";

const SAMPLE_RATE = 48_000;
const SPEED_OF_SOUND_METERS_PER_SECOND = 343;

describe("acoustic room ranging", () => {
  test("derives distance from reciprocal same-device sample intervals despite biased host clocks", () => {
    const meters = 2.4;
    const timeOfFlightSamples = Math.round(
      (meters / SPEED_OF_SOUND_METERS_PER_SECOND) * SAMPLE_RATE,
    );
    const turnaroundSamples = SAMPLE_RATE;
    const hostSelfSample = 100_000;
    const phoneSeesHostSample = 220_000 + timeOfFlightSamples;
    const phoneSelfSample = phoneSeesHostSample + turnaroundSamples;
    const hostSeesPhoneSample =
      hostSelfSample + turnaroundSamples + timeOfFlightSamples * 2;
    const devices = reciprocalDevices({
      hostPulse: pulse("host-pulse", 10_000),
      phonePulse: pulse("phone-pulse", 20_000),
      hostObservations: [
        observation("host-pulse", 50_000, hostSelfSample, 0.34, 0.92),
        observation("phone-pulse", 20_050, hostSeesPhoneSample, 0.32, 0.9),
      ],
      phoneObservations: [
        observation("host-pulse", 9_990, phoneSeesHostSample, 0.31, 0.88),
        observation("phone-pulse", 80_000, phoneSelfSample, 0.35, 0.93),
      ],
    });

    expect(deriveAcousticRanges(devices)).toEqual([
      expect.objectContaining({
        from: "host",
        to: "phone-a",
        pulseId: "phone-pulse",
        pulseIds: ["host-pulse", "phone-pulse"],
        samplesUsed: 1,
        meters: 2.4,
      }),
    ]);
    expect(deriveAcousticRanges(devices)[0].confidence).toBeGreaterThan(0.55);
  });

  test("aggregates repeated reciprocal exchanges into one robust pairwise range", () => {
    const devices = reciprocalDevices({
      hostPulses: [
        pulse("host-pulse-1", 10_000),
        pulse("host-pulse-2", 30_000),
        pulse("host-pulse-3", 50_000),
      ],
      phonePulses: [
        pulse("phone-pulse-1", 15_000),
        pulse("phone-pulse-2", 35_000),
        pulse("phone-pulse-3", 55_000),
      ],
      hostObservations: [
        ...hostExchangeObservations("1", 100_000, 420, 24_000),
        ...hostExchangeObservations("2", 300_000, 430, 24_000),
        ...hostExchangeObservations("3", 500_000, 1_900, 24_000),
      ],
      phoneObservations: [
        ...phoneExchangeObservations("1", 200_000, 420, 24_000),
        ...phoneExchangeObservations("2", 400_000, 430, 24_000),
        ...phoneExchangeObservations("3", 600_000, 1_900, 24_000, 0.08, 0.14),
      ],
    });

    expect(deriveAcousticRanges(devices)).toEqual([
      expect.objectContaining({
        from: "host",
        to: "phone-a",
        pulseId: "phone-pulse-1",
        pulseIds: [
          "host-pulse-1",
          "phone-pulse-1",
          "host-pulse-2",
          "phone-pulse-2",
        ],
        samplesUsed: 2,
        meters: 3.04,
      }),
    ]);
    expect(deriveAcousticRanges(devices)[0].confidence).toBeGreaterThan(0.45);
  });

  test("rejects contradictory two-sample reciprocal ranges instead of averaging them", () => {
    const devices = reciprocalDevices({
      hostPulses: [
        pulse("host-pulse-1", 10_000),
        pulse("host-pulse-2", 30_000),
      ],
      phonePulses: [
        pulse("phone-pulse-1", 15_000),
        pulse("phone-pulse-2", 35_000),
      ],
      hostObservations: [
        ...hostExchangeObservations("1", 100_000, 420, 24_000),
        ...hostExchangeObservations("2", 300_000, 1_900, 24_000),
      ],
      phoneObservations: [
        ...phoneExchangeObservations("1", 200_000, 420, 24_000),
        ...phoneExchangeObservations("2", 400_000, 1_900, 24_000),
      ],
    });

    expect(deriveAcousticRanges(devices)).toEqual([]);
  });

  test("can use scheduled sample-domain emission anchors until self-chirp detections arrive", () => {
    const timeOfFlightSamples = 280;
    const turnaroundSamples = 36_000;
    const hostPulse = pulse("host-pulse", 10_000, {
      emittedSampleIndex: 80_000,
    });
    const phonePulse = pulse("phone-pulse", 16_000, {
      emittedSampleIndex: 180_000 + timeOfFlightSamples + turnaroundSamples,
    });
    const devices = reciprocalDevices({
      hostPulse,
      phonePulse,
      hostObservations: [
        observation(
          "phone-pulse",
          16_010,
          80_000 + turnaroundSamples + timeOfFlightSamples * 2,
          0.31,
          0.82,
        ),
      ],
      phoneObservations: [
        observation(
          "host-pulse",
          10_008,
          180_000 + timeOfFlightSamples,
          0.3,
          0.8,
        ),
      ],
    });

    expect(deriveAcousticRanges(devices)).toEqual([
      expect.objectContaining({
        from: "host",
        to: "phone-a",
        pulseIds: ["host-pulse", "phone-pulse"],
        meters: 2,
      }),
    ]);
  });

  test("does not derive ranges from one-way host timestamp observations", () => {
    const devices: RoomDevice[] = [
      {
        deviceId: "host",
        joinedAt: 1_000,
        lastSeenAt: 2_000,
        role: "host",
        sessionKey: "room",
        acousticPulse: pulse("pulse-1", 10_000),
      },
      {
        deviceId: "phone-a",
        joinedAt: 1_100,
        lastSeenAt: 2_000,
        role: "phone",
        sessionKey: "room",
        acousticObservation: {
          pulseId: "pulse-1",
          detectedAtHostEpochMs: 10_006,
          amplitude: 0.34,
          confidence: 0.9,
          clockUncertaintyMs: 1.2,
        },
      },
    ];

    expect(deriveAcousticRanges(devices)).toEqual([]);
  });

  test("rejects unmatched and physically implausible reciprocal exchanges", () => {
    const devices = reciprocalDevices({
      hostPulse: pulse("host-pulse", 10_000),
      phonePulse: pulse("phone-pulse", 12_000),
      hostObservations: [
        observation("host-pulse", 10_000, 100_000, 0.3, 0.9),
        observation("phone-pulse", 12_090, 120_000, 0.3, 0.9),
      ],
      phoneObservations: [
        observation("host-pulse", 10_006, 200_000, 0.3, 0.9),
        observation("phone-pulse", 12_000, 220_000, 0.3, 0.9),
      ],
    });

    expect(deriveAcousticRanges(devices)).toEqual([]);
  });
});

function reciprocalDevices({
  hostPulse,
  phonePulse,
  hostPulses,
  phonePulses,
  hostObservations,
  phoneObservations,
}: {
  hostPulse?: AcousticPulse;
  phonePulse?: AcousticPulse;
  hostPulses?: AcousticPulse[];
  phonePulses?: AcousticPulse[];
  hostObservations: AcousticObservation[];
  phoneObservations: AcousticObservation[];
}): RoomDevice[] {
  return [
    {
      deviceId: "host",
      joinedAt: 1_000,
      lastSeenAt: 2_000,
      role: "host",
      sessionKey: "room",
      acousticPulse: hostPulse,
      acousticPulses: hostPulses,
      acousticObservations: hostObservations,
    },
    {
      deviceId: "phone-a",
      joinedAt: 1_100,
      lastSeenAt: 2_000,
      role: "phone",
      sessionKey: "room",
      acousticPulse: phonePulse,
      acousticPulses: phonePulses,
      acousticObservations: phoneObservations,
    },
  ];
}

function hostExchangeObservations(
  suffix: string,
  selfSample: number,
  timeOfFlightSamples: number,
  turnaroundSamples: number,
) {
  return [
    observation(`host-pulse-${suffix}`, 10_000, selfSample, 0.34, 0.9),
    observation(
      `phone-pulse-${suffix}`,
      15_000,
      selfSample + turnaroundSamples + timeOfFlightSamples * 2,
      0.32,
      0.88,
    ),
  ];
}

function phoneExchangeObservations(
  suffix: string,
  firstArrivalSample: number,
  timeOfFlightSamples: number,
  turnaroundSamples: number,
  amplitude = 0.32,
  confidence = 0.88,
) {
  return [
    observation(
      `host-pulse-${suffix}`,
      10_006,
      firstArrivalSample + timeOfFlightSamples,
      amplitude,
      confidence,
    ),
    observation(
      `phone-pulse-${suffix}`,
      15_000,
      firstArrivalSample + timeOfFlightSamples + turnaroundSamples,
      amplitude,
      confidence,
    ),
  ];
}

function pulse(
  id: string,
  emittedAtHostEpochMs: number,
  overrides: Partial<AcousticPulse> = {},
): AcousticPulse {
  return {
    id,
    emittedAtHostEpochMs,
    durationMs: 48,
    frequencyHz: 17_200,
    endFrequencyHz: 19_200,
    sampleRate: SAMPLE_RATE,
    ...overrides,
  };
}

function observation(
  pulseId: string,
  detectedAtHostEpochMs: number,
  detectedSampleIndex: number,
  amplitude: number,
  confidence: number,
): AcousticObservation {
  return {
    pulseId,
    detectedAtHostEpochMs,
    detectedSampleIndex,
    sampleRate: SAMPLE_RATE,
    amplitude,
    confidence,
    clockUncertaintyMs: 20,
  };
}
