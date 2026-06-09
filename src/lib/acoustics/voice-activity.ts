import type { AudioFrameTimestamp } from "@/lib/timing/clock-sync";
import type { VoiceActivityEvent } from "@/lib/session/audio-events";

export type VoiceActivityGate = {
  open: boolean;
  lastEventHostEpochMs: number | null;
};

export type VoiceActivityDetectionInput = {
  gate: VoiceActivityGate;
  micLevel: number;
  frame: AudioFrameTimestamp | null;
  openLevel?: number;
  closeLevel?: number;
  minEventSpacingMs?: number;
};

export type VoiceActivityDetectionResult = {
  gate: VoiceActivityGate;
  event: VoiceActivityEvent | null;
};

const DEFAULT_OPEN_LEVEL = 0.045;
const DEFAULT_CLOSE_LEVEL = 0.018;
const DEFAULT_MIN_EVENT_SPACING_MS = 650;

export function detectVoiceActivityEvent({
  gate,
  micLevel,
  frame,
  openLevel = DEFAULT_OPEN_LEVEL,
  closeLevel = DEFAULT_CLOSE_LEVEL,
  minEventSpacingMs = DEFAULT_MIN_EVENT_SPACING_MS,
}: VoiceActivityDetectionInput): VoiceActivityDetectionResult {
  if (!frame) {
    return { gate, event: null };
  }

  if (micLevel <= closeLevel) {
    return {
      gate: { ...gate, open: false },
      event: null,
    };
  }

  const canEmit =
    micLevel >= openLevel &&
    !gate.open &&
    (gate.lastEventHostEpochMs === null ||
      frame.hostEstimatedEpochMs - gate.lastEventHostEpochMs >=
        minEventSpacingMs);

  if (!canEmit) {
    return { gate, event: null };
  }

  const event: VoiceActivityEvent = {
    id: `voice-${Math.round(frame.sampleIndex)}-${Math.round(
      frame.hostEstimatedEpochMs,
    )}`,
    detectedAtHostEpochMs: frame.hostEstimatedEpochMs,
    audioContextTimeSeconds: frame.audioContextTimeSeconds,
    sampleIndex: frame.sampleIndex,
    sampleRate: frame.sampleRate,
    audioLevel: round(micLevel),
    confidence: voiceConfidence(micLevel, frame.clockUncertaintyMs),
    clockOffsetMs: frame.clockOffsetMs,
    clockUncertaintyMs: frame.clockUncertaintyMs,
    clockQuality: frame.clockQuality ?? null,
  };

  return {
    gate: {
      open: true,
      lastEventHostEpochMs: frame.hostEstimatedEpochMs,
    },
    event,
  };
}

function voiceConfidence(micLevel: number, clockUncertaintyMs: number) {
  const levelScore = Math.max(0, Math.min(1, micLevel / 0.08));
  const timingScore = 1 / (1 + Math.max(0, clockUncertaintyMs) / 24);
  return round(Math.max(0.05, Math.min(1, levelScore * timingScore)));
}

function round(value: number) {
  return Number(value.toFixed(3));
}
