import { estimateRoomConstellation } from "../positioning/room-state-layout";
import { createSessionRegistry, type RoomState } from "../session/registry";

export type SimulatedPhone = {
  deviceId: string;
  x: number;
  y: number;
};

export type AcousticRoomSimulationOptions = {
  roomUrl: string;
  devices: SimulatedPhone[];
  sampleRate?: number;
  exchangesPerPair?: number;
  sampleNoiseStdDev?: number;
};

export type AcousticRoomSimulationResult = {
  roomState: RoomState;
  constellation: ReturnType<typeof estimateRoomConstellation>;
  maxRangeErrorMeters: number;
  maxLayoutPairErrorMeters: number;
};

const SPEED_OF_SOUND_METERS_PER_SECOND = 343;
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_EXCHANGES_PER_PAIR = 2;
const DEFAULT_TURN_SAMPLES = 24_000;
const SLOT_SPACING_MS = 1_350;
const BASE_HOST_EPOCH_MS = 100_000;
const BASE_SAMPLE_INDEX = 160_000;

export function simulateAcousticRoom(
  options: AcousticRoomSimulationOptions,
): AcousticRoomSimulationResult {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const exchangesPerPair =
    options.exchangesPerPair ?? DEFAULT_EXCHANGES_PER_PAIR;
  const sampleNoiseStdDev = options.sampleNoiseStdDev ?? 0;
  let hostEpochNowMs = BASE_HOST_EPOCH_MS;
  const registry = createSessionRegistry({ now: () => hostEpochNowMs });

  for (const device of options.devices) {
    registry.claim(options.roomUrl, device.deviceId);
  }

  const pairs = phonePairs(options.devices);
  let sequence = 0;
  for (let exchange = 0; exchange < exchangesPerPair; exchange += 1) {
    for (const pair of pairs) {
      publishReciprocalExchange({
        registry,
        roomUrl: options.roomUrl,
        first: pair[0],
        second: pair[1],
        sampleRate,
        sequence,
        sampleNoiseStdDev,
        setNow: (value) => {
          hostEpochNowMs = value;
        },
      });
      sequence += 1;
    }
  }

  const roomState = registry.state(options.roomUrl);
  const constellation = estimateRoomConstellation(roomState);

  return {
    roomState,
    constellation,
    maxRangeErrorMeters: maxRangeErrorMeters(options.devices, roomState),
    maxLayoutPairErrorMeters: maxLayoutPairErrorMeters(
      options.devices,
      constellation.layout.points,
    ),
  };
}

function publishReciprocalExchange({
  registry,
  roomUrl,
  first,
  second,
  sampleRate,
  sequence,
  sampleNoiseStdDev,
  setNow,
}: {
  registry: ReturnType<typeof createSessionRegistry>;
  roomUrl: string;
  first: SimulatedPhone;
  second: SimulatedPhone;
  sampleRate: number;
  sequence: number;
  sampleNoiseStdDev: number;
  setNow: (value: number) => void;
}) {
  const distanceMeters = distanceMetersBetween(first, second);
  const tofMs = (distanceMeters / SPEED_OF_SOUND_METERS_PER_SECOND) * 1_000;
  const tofSamples = (tofMs / 1_000) * sampleRate;
  const firstPulseId = pulseId(first.deviceId, second.deviceId, sequence, "a");
  const secondPulseId = pulseId(first.deviceId, second.deviceId, sequence, "b");
  const firstPulseHostEpochMs = BASE_HOST_EPOCH_MS + sequence * SLOT_SPACING_MS;
  const secondPulseHostEpochMs =
    firstPulseHostEpochMs + (DEFAULT_TURN_SAMPLES / sampleRate) * 1_000;
  const firstSelfSample =
    BASE_SAMPLE_INDEX + sequence * 210_000 + sampleOriginOffset(first.deviceId);
  const secondHearFirstSample =
    BASE_SAMPLE_INDEX +
    sequence * 190_000 +
    sampleOriginOffset(second.deviceId) +
    tofSamples;
  const secondSelfSample = secondHearFirstSample + DEFAULT_TURN_SAMPLES;
  const firstHearSecondSample =
    firstSelfSample + DEFAULT_TURN_SAMPLES + tofSamples * 2;

  heartbeatAt(registry, roomUrl, first.deviceId, firstPulseHostEpochMs, setNow, {
    sampleRate,
    acousticPulse: pulse(firstPulseId, firstPulseHostEpochMs, sampleRate),
  });
  heartbeatAt(registry, roomUrl, first.deviceId, firstPulseHostEpochMs, setNow, {
    sampleRate,
    acousticObservation: observation(
      firstPulseId,
      firstPulseHostEpochMs,
      firstSelfSample + sampleNoise(sequence, 0, sampleNoiseStdDev),
      sampleRate,
      0.38,
      0.94,
    ),
  });
  heartbeatAt(
    registry,
    roomUrl,
    second.deviceId,
    firstPulseHostEpochMs + tofMs,
    setNow,
    {
      sampleRate,
      acousticObservation: observation(
        firstPulseId,
        firstPulseHostEpochMs + tofMs,
        secondHearFirstSample + sampleNoise(sequence, 1, sampleNoiseStdDev),
        sampleRate,
        0.34,
        0.91,
      ),
    },
  );
  heartbeatAt(registry, roomUrl, second.deviceId, secondPulseHostEpochMs, setNow, {
    sampleRate,
    acousticPulse: pulse(secondPulseId, secondPulseHostEpochMs, sampleRate),
  });
  heartbeatAt(registry, roomUrl, second.deviceId, secondPulseHostEpochMs, setNow, {
    sampleRate,
    acousticObservation: observation(
      secondPulseId,
      secondPulseHostEpochMs,
      secondSelfSample + sampleNoise(sequence, 2, sampleNoiseStdDev),
      sampleRate,
      0.37,
      0.93,
    ),
  });
  heartbeatAt(
    registry,
    roomUrl,
    first.deviceId,
    secondPulseHostEpochMs + tofMs,
    setNow,
    {
      sampleRate,
      acousticObservation: observation(
        secondPulseId,
        secondPulseHostEpochMs + tofMs,
        firstHearSecondSample + sampleNoise(sequence, 3, sampleNoiseStdDev),
        sampleRate,
        0.33,
        0.9,
      ),
    },
  );
}

function heartbeatAt(
  registry: ReturnType<typeof createSessionRegistry>,
  roomUrl: string,
  deviceId: string,
  hostEpochMs: number,
  setNow: (value: number) => void,
  heartbeat: Parameters<ReturnType<typeof createSessionRegistry>["heartbeat"]>[2],
) {
  setNow(hostEpochMs);
  registry.heartbeat(roomUrl, deviceId, {
    mic: "active",
    sampleRate: heartbeat?.sampleRate ?? DEFAULT_SAMPLE_RATE,
    motion: "active",
    motionStability: 0.96,
    ...heartbeat,
  });
}

function pulse(id: string, emittedAtHostEpochMs: number, sampleRate: number) {
  return {
    id,
    emittedAtHostEpochMs,
    durationMs: 48,
    frequencyHz: 17_200,
    endFrequencyHz: 19_200,
    sampleRate,
  };
}

function observation(
  pulseId: string,
  detectedAtHostEpochMs: number,
  detectedSampleIndex: number,
  sampleRate: number,
  amplitude: number,
  confidence: number,
) {
  return {
    pulseId,
    detectedAtHostEpochMs,
    detectedSampleIndex,
    sampleRate,
    amplitude,
    confidence,
    clockUncertaintyMs: 2,
  };
}

function phonePairs(devices: SimulatedPhone[]) {
  const pairs: Array<[SimulatedPhone, SimulatedPhone]> = [];
  for (let left = 0; left < devices.length; left += 1) {
    for (let right = left + 1; right < devices.length; right += 1) {
      pairs.push([devices[left], devices[right]]);
    }
  }
  return pairs;
}

function maxRangeErrorMeters(devices: SimulatedPhone[], roomState: RoomState) {
  const errors = phonePairs(devices).map(([left, right]) => {
    const range = roomState.ranges.find(
      (candidate) =>
        (candidate.from === left.deviceId && candidate.to === right.deviceId) ||
        (candidate.from === right.deviceId && candidate.to === left.deviceId),
    );
    return range
      ? Math.abs(range.meters - distanceMetersBetween(left, right))
      : Number.POSITIVE_INFINITY;
  });
  return round(Math.max(...errors));
}

function maxLayoutPairErrorMeters(
  devices: SimulatedPhone[],
  points: Record<string, { x: number; y: number }>,
) {
  const errors = phonePairs(devices).map(([left, right]) => {
    const leftPoint = points[left.deviceId];
    const rightPoint = points[right.deviceId];
    if (!leftPoint || !rightPoint) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.abs(
      Math.hypot(rightPoint.x - leftPoint.x, rightPoint.y - leftPoint.y) -
        distanceMetersBetween(left, right),
    );
  });
  return round(Math.max(...errors));
}

function distanceMetersBetween(left: SimulatedPhone, right: SimulatedPhone) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function pulseId(
  firstDeviceId: string,
  secondDeviceId: string,
  sequence: number,
  suffix: string,
) {
  return `${firstDeviceId}:${secondDeviceId}:${sequence}:${suffix}`;
}

function sampleOriginOffset(deviceId: string) {
  let hash = 0;
  for (const character of deviceId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 10_000;
  }
  return hash * 17;
}

function sampleNoise(sequence: number, channel: number, stdDev: number) {
  if (stdDev <= 0) {
    return 0;
  }
  const uniformA = pseudoRandom(sequence * 8 + channel * 2 + 1);
  const uniformB = pseudoRandom(sequence * 8 + channel * 2 + 2);
  return (
    Math.sqrt(-2 * Math.log(Math.max(1e-9, uniformA))) *
    Math.cos(2 * Math.PI * uniformB) *
    stdDev
  );
}

function pseudoRandom(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function round(value: number) {
  return Number(value.toFixed(4));
}
