import { describe, expect, it } from "vitest";
import { captureAudioSnippet } from "../acoustics/audio-snippet";
import type {
  ReconciledAudioEvent,
  ReconciledAudioEventObservation,
} from "../session/audio-events";
import { derivePairTdoaObservations } from "./tdoa-observations";
import { pairKeyFor } from "./pair-tdoa-history";

const SAMPLE_RATE = 48_000;
const EPOCH0 = 5_000_000;

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Speech-band test signal evaluable at arbitrary (fractional) times, so true
// sub-sample propagation delays can be synthesized exactly.
function makeSpeechLikeSignal(seed: number) {
  const random = mulberry32(seed);
  const components: Array<{ frequency: number; phase: number; amplitude: number }> = [];
  for (let index = 0; index < 420; index += 1) {
    components.push({
      frequency: 250 + random() * 3_350,
      phase: random() * 2 * Math.PI,
      amplitude: 0.2 + random() * 0.8,
    });
  }
  return (timeSeconds: number) => {
    // Syllable-ish amplitude modulation keeps the envelope speech-like.
    const envelope =
      0.55 +
      0.45 * Math.sin(2 * Math.PI * 3.1 * timeSeconds) *
        Math.sin(2 * Math.PI * 0.7 * timeSeconds + 1.1);
    let value = 0;
    for (const component of components) {
      value +=
        component.amplitude *
        Math.sin(2 * Math.PI * component.frequency * timeSeconds + component.phase);
    }
    return (value / 45) * envelope;
  };
}

type SyntheticDevice = {
  deviceId: string;
  // Talker→device propagation delay.
  delayMs: number;
  // Constant host-clock mapping error (sync residual + pipeline latency).
  clockErrorMs: number;
  // How late this device's VAD fired relative to the shared onset.
  vadJitterMs: number;
  // Replace the real signal with unrelated noise (broken mic / wrong room).
  corrupted?: boolean;
};

function buildObservation(
  signal: (t: number) => number,
  device: SyntheticDevice,
  seed: number,
): ReconciledAudioEventObservation {
  const random = mulberry32(seed);
  const onsetSeconds = 0.5;
  const centerSeconds = onsetSeconds + device.delayMs / 1_000 + device.vadJitterMs / 1_000;
  const centerSampleIndex = Math.round(centerSeconds * SAMPLE_RATE);
  const windowSamples = Math.round(0.4 * SAMPLE_RATE);
  const startSampleIndex = centerSampleIndex - windowSamples / 2;
  const samples = new Float32Array(windowSamples);
  for (let index = 0; index < windowSamples; index += 1) {
    const t = (startSampleIndex + index) / SAMPLE_RATE;
    samples[index] = device.corrupted
      ? (random() - 0.5) * 0.4
      : signal(t - device.delayMs / 1_000) + (random() - 0.5) * 0.01;
  }

  const snippet = captureAudioSnippet({
    samples,
    sampleRate: SAMPLE_RATE,
    startSampleIndex,
    centerSampleIndex,
  });
  expect(snippet).not.toBeNull();

  const detectedAtHostEpochMs =
    EPOCH0 + (centerSampleIndex / SAMPLE_RATE) * 1_000 + device.clockErrorMs;
  return {
    deviceId: device.deviceId,
    eventId: `voice-${device.deviceId}`,
    detectedAtHostEpochMs,
    sampleIndex: centerSampleIndex,
    sampleRate: SAMPLE_RATE,
    audioLevel: 0.1,
    confidence: 0.9,
    clockUncertaintyMs: 2,
    audioSnippet: snippet,
  };
}

function buildEvent(observations: ReconciledAudioEventObservation[]): ReconciledAudioEvent {
  const times = observations.map((entry) => entry.detectedAtHostEpochMs);
  return {
    id: `voice:${Math.round(Math.min(...times))}:${observations[0].eventId}`,
    startedAtHostEpochMs: Math.min(...times),
    endedAtHostEpochMs: Math.max(...times),
    centerHostEpochMs: times.reduce((a, b) => a + b, 0) / times.length,
    timeSpreadMs: Math.max(...times) - Math.min(...times),
    arrivalLeaderDeviceId: observations[0].deviceId,
    observedDeviceIds: observations.map((entry) => entry.deviceId),
    observations,
    timestampUncertaintyMs: 2,
    timingConfidence: 0.9,
    confidence: 0.9,
  };
}

describe("derivePairTdoaObservations", () => {
  it("recovers the true arrival difference including the clock bias", () => {
    const signal = makeSpeechLikeSignal(3);
    const event = buildEvent([
      buildObservation(signal, { deviceId: "alpha", delayMs: 2.5, clockErrorMs: -4, vadJitterMs: 3 }, 21),
      buildObservation(signal, { deviceId: "bravo", delayMs: 9.1, clockErrorMs: 7, vadJitterMs: -5 }, 22),
    ]);

    const observations = derivePairTdoaObservations(event);
    expect(observations).toHaveLength(1);
    const [pair] = observations;
    expect(pair.pairKey).toBe(pairKeyFor("alpha", "bravo"));
    expect(pair.from).toBe("alpha");
    expect(pair.to).toBe("bravo");
    // Sample-domain timing: the true arrival difference (9.1 − 2.5) comes
    // through exactly, and the devices' host-clock errors (−4 and +7 ms)
    // must NOT leak in — that immunity is the whole point.
    expect(pair.tdoaMs).toBeGreaterThan(6.6 - 0.25);
    expect(pair.tdoaMs).toBeLessThan(6.6 + 0.25);
    expect(pair.weight).toBeGreaterThan(0.3);
    expect(pair.eventId).toBe(event.id);
  });

  it("is independent of when each device's VAD happened to fire", () => {
    const signal = makeSpeechLikeSignal(5);
    const jitters = [
      [0, 0],
      [12, -9],
      [-14, 11],
    ];
    const results = jitters.map(([jitterA, jitterB]) => {
      const event = buildEvent([
        buildObservation(signal, { deviceId: "alpha", delayMs: 1, clockErrorMs: 0, vadJitterMs: jitterA }, 31),
        buildObservation(signal, { deviceId: "bravo", delayMs: 6.8, clockErrorMs: 0, vadJitterMs: jitterB }, 32),
      ]);
      const [pair] = derivePairTdoaObservations(event);
      return pair?.tdoaMs ?? Number.NaN;
    });
    for (const tdoaMs of results) {
      expect(Math.abs(tdoaMs - 5.8)).toBeLessThan(0.25);
    }
  });

  it("produces all pairs for a three-device event and they close the triangle", () => {
    const signal = makeSpeechLikeSignal(9);
    const event = buildEvent([
      buildObservation(signal, { deviceId: "alpha", delayMs: 2, clockErrorMs: -3, vadJitterMs: 4 }, 41),
      buildObservation(signal, { deviceId: "bravo", delayMs: 7.4, clockErrorMs: 5, vadJitterMs: -2 }, 42),
      buildObservation(signal, { deviceId: "charlie", delayMs: 4.9, clockErrorMs: 11, vadJitterMs: 1 }, 43),
    ]);

    const observations = derivePairTdoaObservations(event);
    expect(observations).toHaveLength(3);
    const byPair = new Map(observations.map((entry) => [entry.pairKey, entry]));
    const ab = byPair.get(pairKeyFor("alpha", "bravo"))!;
    const bc = byPair.get(pairKeyFor("bravo", "charlie"))!;
    const ac = byPair.get(pairKeyFor("alpha", "charlie"))!;
    expect(ab).toBeDefined();
    expect(bc).toBeDefined();
    expect(ac).toBeDefined();
    // τ_AB + τ_BC = τ_AC (orientation: from is the lexically smaller id).
    expect(Math.abs(ab.tdoaMs + bc.tdoaMs - ac.tdoaMs)).toBeLessThan(0.5);
  });

  it("drops pairs whose audio does not actually match", () => {
    const signal = makeSpeechLikeSignal(13);
    const event = buildEvent([
      buildObservation(signal, { deviceId: "alpha", delayMs: 2, clockErrorMs: 0, vadJitterMs: 0 }, 51),
      buildObservation(signal, { deviceId: "bravo", delayMs: 5, clockErrorMs: 0, vadJitterMs: 0, corrupted: true }, 52),
    ]);
    expect(derivePairTdoaObservations(event)).toHaveLength(0);
  });

  it("ignores observations without snippets", () => {
    const signal = makeSpeechLikeSignal(17);
    const withSnippet = buildObservation(signal, { deviceId: "alpha", delayMs: 2, clockErrorMs: 0, vadJitterMs: 0 }, 61);
    const withoutSnippet = {
      ...buildObservation(signal, { deviceId: "bravo", delayMs: 5, clockErrorMs: 0, vadJitterMs: 0 }, 62),
      audioSnippet: null,
    };
    const event = buildEvent([withSnippet, withoutSnippet]);
    expect(derivePairTdoaObservations(event)).toHaveLength(0);
  });
});
