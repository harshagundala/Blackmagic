import type { AcousticPulse } from "@/lib/session/registry";

export type PulseToneParam = {
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime?(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime?(value: number, endTime: number): unknown;
};

export type PulseToneOscillator = {
  type: OscillatorType | "sine";
  frequency: PulseToneParam;
  connect(destination: unknown): unknown;
  disconnect?(): unknown;
  start(when: number): unknown;
  stop(when: number): unknown;
  onended?: ((event: Event) => void) | null;
};

export type PulseToneGain = {
  gain: PulseToneParam;
  connect(destination: unknown): unknown;
  disconnect?(): unknown;
};

export type PulseToneAudioContext = {
  currentTime: number;
  destination: unknown;
  state?: AudioContextState | "running" | "suspended" | "closed";
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
  createOscillator(): PulseToneOscillator;
  createGain(): PulseToneGain;
};

export type PulseToneScheduler = {
  schedule(
    pulse: AcousticPulse,
    timing: { hostEpochNowMs: number; peakGain?: number },
  ): Promise<void>;
  close(): Promise<void>;
};

export type PulseToneSchedulerOptions = {
  createContext: () => PulseToneAudioContext;
  minimumLeadSeconds?: number;
  peakGain?: number;
  // False when the scheduler plays through a context someone else manages
  // (e.g. the capture context); close() then releases the reference without
  // closing the shared context.
  ownsContext?: boolean;
};

const DEFAULT_MINIMUM_LEAD_SECONDS = 0.02;
// The chirp band (≥18.5 kHz) is inaudible, but phone speakers and mics both
// roll off hard up there. A timid gain leaves the matched filter with nothing
// to correlate beyond arm's length, so drive the tone hard.
const DEFAULT_PEAK_GAIN = 0.8;
const FLOOR_GAIN = 0.0001;
// A slow attack/release matters for inaudibility: a fast onset of a loud tone
// splatters broadband energy (an audible "tick") across the spectrum, even
// when the tone itself is ultrasonic. 25 ms cosine-like ramps keep the onset
// and tail smooth so nothing audible leaks; the chirp is long enough (200 ms)
// that the ramps cost little correlation energy.
const ATTACK_SECONDS = 0.025;
const RELEASE_SECONDS = 0.025;

export function createPulseToneScheduler({
  createContext,
  minimumLeadSeconds = DEFAULT_MINIMUM_LEAD_SECONDS,
  peakGain = DEFAULT_PEAK_GAIN,
  ownsContext = true,
}: PulseToneSchedulerOptions): PulseToneScheduler {
  let context: PulseToneAudioContext | null = null;

  async function audioContext() {
    if (!context || context.state === "closed") {
      context = createContext();
    }
    // "suspended" or iOS's non-standard "interrupted": both need a resume.
    if (context.state !== "running" && context.state !== "closed" && context.resume) {
      await context.resume().catch(() => undefined);
    }
    return context;
  }

  return {
    async schedule(pulse, { hostEpochNowMs, peakGain: pulseGain }) {
      const activeContext = await audioContext();
      const startTime = pulseStartTimeSeconds({
        pulse,
        hostEpochNowMs,
        audioContextCurrentTimeSeconds: activeContext.currentTime,
        minimumLeadSeconds,
      });
      scheduleTone(activeContext, pulse, startTime, pulseGain ?? peakGain);
    },

    async close() {
      const closingContext = context;
      context = null;
      if (ownsContext) {
        await closingContext?.close?.().catch(() => undefined);
      }
    },
  };
}

export function pulseStartTimeSeconds({
  pulse,
  hostEpochNowMs,
  audioContextCurrentTimeSeconds,
  minimumLeadSeconds = DEFAULT_MINIMUM_LEAD_SECONDS,
}: {
  pulse: AcousticPulse;
  hostEpochNowMs: number;
  audioContextCurrentTimeSeconds: number;
  minimumLeadSeconds?: number;
}) {
  const intendedDelaySeconds =
    (pulse.emittedAtHostEpochMs - hostEpochNowMs) / 1_000;
  const boundedDelaySeconds = Math.max(
    minimumLeadSeconds,
    intendedDelaySeconds,
  );

  return roundTime(audioContextCurrentTimeSeconds + boundedDelaySeconds);
}

function scheduleTone(
  context: PulseToneAudioContext,
  pulse: AcousticPulse,
  startTime: number,
  peakGain: number,
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const durationSeconds = pulse.durationMs / 1_000;
  const endTime = roundTime(startTime + durationSeconds);

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(pulse.frequencyHz, startTime);
  if (
    pulse.endFrequencyHz &&
    pulse.endFrequencyHz !== pulse.frequencyHz &&
    oscillator.frequency.linearRampToValueAtTime
  ) {
    oscillator.frequency.linearRampToValueAtTime(pulse.endFrequencyHz, endTime);
  }

  // Flat-top (Tukey) envelope: smooth attack, hold at peak, smooth release.
  // Holding the peak instead of decaying across the whole tone keeps the
  // chirp energy near-constant — what the matched-filter template expects —
  // while the tapered edges avoid an audible onset/offset click.
  const attack = Math.min(ATTACK_SECONDS, durationSeconds / 3);
  const release = Math.min(RELEASE_SECONDS, durationSeconds / 3);
  const peak = Math.max(FLOOR_GAIN, peakGain);
  gain.gain.setValueAtTime(FLOOR_GAIN, startTime);
  gain.gain.exponentialRampToValueAtTime?.(peak, roundTime(startTime + attack));
  gain.gain.setValueAtTime?.(peak, roundTime(endTime - release));
  gain.gain.exponentialRampToValueAtTime?.(FLOOR_GAIN, endTime);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.onended = () => {
    oscillator.disconnect?.();
    gain.disconnect?.();
  };
  oscillator.start(startTime);
  oscillator.stop(endTime);
}

function roundTime(value: number) {
  return Number(value.toFixed(6));
}
