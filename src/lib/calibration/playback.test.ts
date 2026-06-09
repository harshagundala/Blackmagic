import { describe, expect, test, vi } from "vitest";
import {
  createPulseToneScheduler,
  pulseStartTimeSeconds,
  type PulseToneAudioContext,
} from "./playback";
import type { AcousticPulse } from "@/lib/session/registry";

describe("pulse tone playback scheduling", () => {
  test("maps intended host epoch to an audio-clock start time", () => {
    expect(
      pulseStartTimeSeconds({
        pulse: pulse({ emittedAtHostEpochMs: 12_500 }),
        hostEpochNowMs: 10_000,
        audioContextCurrentTimeSeconds: 3.25,
      }),
    ).toBe(5.75);
  });

  test("keeps a minimum audio-clock lead for late pulses", () => {
    expect(
      pulseStartTimeSeconds({
        pulse: pulse({ emittedAtHostEpochMs: 9_900 }),
        hostEpochNowMs: 10_000,
        audioContextCurrentTimeSeconds: 3.25,
        minimumLeadSeconds: 0.04,
      }),
    ).toBe(3.29);
  });

  test("reuses one audio context and schedules oscillators on that clock", async () => {
    const first = pulse({ id: "pulse-1", emittedAtHostEpochMs: 12_000 });
    const second = pulse({ id: "pulse-2", emittedAtHostEpochMs: 13_000 });
    const context = fakeAudioContext();
    const createContext = vi.fn(() => context);
    const scheduler = createPulseToneScheduler({ createContext });

    await scheduler.schedule(first, { hostEpochNowMs: 10_000 });
    context.currentTime = 11;
    await scheduler.schedule(second, { hostEpochNowMs: 12_500 });

    expect(createContext).toHaveBeenCalledTimes(1);
    expect(context.oscillators).toHaveLength(2);
    expect(context.oscillators[0].start).toHaveBeenCalledWith(12);
    expect(context.oscillators[0].stop).toHaveBeenCalledWith(12.048);
    expect(context.oscillators[1].start).toHaveBeenCalledWith(11.5);
    expect(context.oscillators[1].frequency.linearRampToValueAtTime).toHaveBeenCalledWith(
      19_200,
      11.548,
    );
  });
});

function pulse(overrides: Partial<AcousticPulse> = {}): AcousticPulse {
  return {
    id: "pulse",
    emittedAtHostEpochMs: 12_000,
    durationMs: 48,
    frequencyHz: 17_200,
    endFrequencyHz: 19_200,
    ...overrides,
  };
}

function fakeAudioContext() {
  const context = {
    currentTime: 10,
    destination: { id: "destination" },
    state: "running",
    oscillators: [] as ReturnType<typeof fakeOscillator>[],
    gains: [] as ReturnType<typeof fakeGain>[],
    createOscillator() {
      const oscillator = fakeOscillator();
      this.oscillators.push(oscillator);
      return oscillator;
    },
    createGain() {
      const gain = fakeGain();
      this.gains.push(gain);
      return gain;
    },
  } satisfies PulseToneAudioContext & {
    oscillators: ReturnType<typeof fakeOscillator>[];
    gains: ReturnType<typeof fakeGain>[];
  };

  return context;
}

function fakeOscillator() {
  return {
    type: "sine" as OscillatorType,
    frequency: {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function fakeGain() {
  return {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}
