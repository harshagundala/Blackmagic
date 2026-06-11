// Synthetic acoustic scenes for reconciliation tests: a talker emitting a
// speech-band signal at known positions, captured by devices with known
// positions, per-device clock errors, sample-rate drift, and VAD jitter.
// Snippets go through the real captureAudioSnippet path so tests exercise
// the same quantization, decimation, and GCC-PHAT code as production.

import { captureAudioSnippet } from "../acoustics/audio-snippet";
import type { VoiceActivityEvent } from "../session/audio-events";

export const TEST_SPEED_OF_SOUND = 343;
const SAMPLE_RATE = 48_000;
const COMPONENT_COUNT = 180;
const WINDOW_SECONDS = 0.3;

export function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A noise-like speech-band signal sampled on a 4× oversampled grid, with
// cubic interpolation for arbitrary fractional times. Oversampling keeps the
// interpolation error far below the quantization floor of the 8-bit snippet
// encoding while letting each event's base signal be synthesized once and
// shared across devices.
export type SpeechSignal = (timeSeconds: number) => number;

const signalCache = new Map<number, SpeechSignal>();

export function makeSpeechLikeSignal(seed: number): SpeechSignal {
  const cached = signalCache.get(seed);
  if (cached) {
    return cached;
  }

  const random = mulberry32(seed);
  const components: Array<{ omega: number; phase: number; amplitude: number }> =
    [];
  for (let index = 0; index < COMPONENT_COUNT; index += 1) {
    components.push({
      omega: 2 * Math.PI * (250 + random() * 3_350),
      phase: random() * 2 * Math.PI,
      amplitude: 0.2 + random() * 0.8,
    });
  }

  const gridRate = SAMPLE_RATE * 4;
  // Generous margin around the window so delayed/jittered reads stay inside.
  const gridStartSeconds = -0.4;
  const gridLength = Math.round(1.2 * gridRate);
  const grid = new Float32Array(gridLength);
  for (const component of components) {
    const step = component.omega / gridRate;
    let angle = component.omega * gridStartSeconds + component.phase;
    for (let index = 0; index < gridLength; index += 1) {
      grid[index] += component.amplitude * Math.sin(angle);
      angle += step;
    }
  }
  const scale = 1 / 30;

  const signal: SpeechSignal = (timeSeconds: number) => {
    const position = (timeSeconds - gridStartSeconds) * gridRate;
    const base = Math.floor(position);
    if (base < 1 || base + 2 >= gridLength) {
      return 0;
    }
    const fraction = position - base;
    const p0 = grid[base - 1];
    const p1 = grid[base];
    const p2 = grid[base + 1];
    const p3 = grid[base + 2];
    // Catmull-Rom cubic.
    const value =
      p1 +
      0.5 *
        fraction *
        (p2 -
          p0 +
          fraction *
            (2 * p0 -
              5 * p1 +
              4 * p2 -
              p3 +
              fraction * (3 * (p1 - p2) + p3 - p0)));
    const envelope =
      0.55 +
      0.45 *
        Math.sin(2 * Math.PI * 3.1 * timeSeconds) *
        Math.sin(2 * Math.PI * 0.7 * timeSeconds + 1.1);
    return value * scale * envelope;
  };

  signalCache.set(seed, signal);
  if (signalCache.size > 80) {
    const oldest = signalCache.keys().next().value;
    if (oldest !== undefined) {
      signalCache.delete(oldest);
    }
  }
  return signal;
}

export type SceneDevice = {
  deviceId: string;
  x: number;
  y: number;
  // Host-clock mapping error: shifts detectedAtHostEpochMs only. Since TDOA
  // is measured in the sample domain this must NOT shift estimates.
  clockErrorMs: number;
  // When this device's ADC sample counter started, in true epoch ms. The
  // pairwise difference of capture starts is the sample-domain bias Δ.
  captureStartEpochMs?: number;
  // ADC sample-rate offset: device-local sample time drifts by this many ms
  // per true second (≈ ppm/1000 · 1000).
  clockDriftMsPerSecond?: number;
  // Nominal capture rate (iOS voice-processed capture runs at 24 kHz while
  // raw capture runs at 48 kHz; both must interoperate).
  captureSampleRate?: number;
};

export type SyntheticVoiceEventInput = {
  device: SceneDevice;
  talker: { x: number; y: number };
  // When the utterance happened on the true shared timeline.
  utteranceEpochMs: number;
  sessionStartEpochMs: number;
  signalSeed: number;
  noiseSeed: number;
  vadJitterMs?: number;
};

// Builds the VoiceActivityEvent the device's sensor suite would emit for an
// utterance: snippet cut around its own (jittered) VAD trigger, detection
// timestamp mapped through its erroneous clock.
export function syntheticVoiceEvent({
  device,
  talker,
  utteranceEpochMs,
  sessionStartEpochMs,
  signalSeed,
  noiseSeed,
  vadJitterMs = 0,
}: SyntheticVoiceEventInput): VoiceActivityEvent {
  const signal = makeSpeechLikeSignal(signalSeed);
  const random = mulberry32(noiseSeed);
  const delaySeconds =
    Math.hypot(talker.x - device.x, talker.y - device.y) / TEST_SPEED_OF_SOUND;

  const clockErrorMs = device.clockErrorMs;
  const sampleRate = device.captureSampleRate ?? SAMPLE_RATE;
  const captureStartEpochMs = device.captureStartEpochMs ?? sessionStartEpochMs;
  // True ADC rate differs from nominal by the sample-rate offset; the device
  // labels indices nominally, so its sample-domain time drifts against true
  // time at clockDriftMsPerSecond.
  const rateScale = 1 + (device.clockDriftMsPerSecond ?? 0) / 1_000;
  const trueEpochOfSample = (sampleIndex: number) =>
    captureStartEpochMs + (sampleIndex / (sampleRate * rateScale)) * 1_000;
  const sampleAtTrueEpoch = (epochMs: number) =>
    ((epochMs - captureStartEpochMs) / 1_000) * sampleRate * rateScale;

  // Sound from the utterance arrives at utteranceEpochMs + delay; the VAD
  // fires nearby.
  const arrivalEpochMs = utteranceEpochMs + delaySeconds * 1_000;
  const centerSampleIndex = Math.round(
    sampleAtTrueEpoch(arrivalEpochMs + vadJitterMs),
  );
  const windowSamples = Math.round(WINDOW_SECONDS * sampleRate);
  const startSampleIndex = centerSampleIndex - windowSamples / 2;
  const samples = new Float32Array(windowSamples);
  for (let index = 0; index < windowSamples; index += 1) {
    const trueEpochMs = trueEpochOfSample(startSampleIndex + index);
    const sourceTimeSeconds =
      (trueEpochMs - delaySeconds * 1_000 - utteranceEpochMs) / 1_000;
    samples[index] = signal(sourceTimeSeconds) + (random() - 0.5) * 0.01;
  }

  const audioSnippet = captureAudioSnippet({
    samples,
    sampleRate,
    startSampleIndex,
    centerSampleIndex,
  });

  const detectedAtHostEpochMs =
    trueEpochOfSample(centerSampleIndex) + clockErrorMs;

  return {
    id: `voice-${device.deviceId}-${Math.round(utteranceEpochMs)}`,
    detectedAtHostEpochMs,
    audioContextTimeSeconds: centerSampleIndex / sampleRate,
    sampleIndex: centerSampleIndex,
    sampleRate,
    audioLevel: 0.1,
    confidence: 0.9,
    clockOffsetMs: 0,
    clockUncertaintyMs: 2,
    timingConfidence: 0.9,
    motionStability: 1,
    audioSnippet,
  };
}
