import type { AudioFrameTimestamp } from "@/lib/timing/clock-sync";
import type { VoiceActivityEvent } from "@/lib/session/audio-events";

export type VoiceActivityGate = {
  open: boolean;
  lastEventHostEpochMs: number | null;
  // Rolling estimate of the quiet-room RMS, learned on the fly. Real phone
  // captures sit around 1e-4 RMS (the capture-health constants call 1e-4
  // "healthy"), so fixed absolute thresholds tuned in the 1e-2 range never
  // fire on actual hardware; the gate has to adapt to the device's floor.
  noiseFloorLevel?: number | null;
  samplesSeen?: number;
};

export type VoiceActivityDetectionInput = {
  gate: VoiceActivityGate;
  micLevel: number;
  frame: AudioFrameTimestamp | null;
  motionStability?: number | null;
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
// Events snap to a shared host-clock grid so every phone cuts its snippet
// around the SAME instants (clock sync is ±10 ms, the cluster window 80 ms):
// each grid tick during speech pairs across the whole room instead of
// devices free-running past each other.
const DEFAULT_MIN_EVENT_SPACING_MS = 500;
// Adaptive thresholds: voice is a sustained rise above the learned floor.
const ADAPTIVE_OPEN_RATIO = 5;
const ADAPTIVE_CLOSE_RATIO = 2;
// Hard floors keep digital near-silence (1e-5 and below) from ever counting
// as voice no matter how low the learned floor drifts.
const MIN_ADAPTIVE_OPEN_LEVEL = 6e-5;
const MIN_ADAPTIVE_CLOSE_LEVEL = 3e-5;
// ~0.5 s of analyser reads before the adaptive path may fire, so a noisy
// app launch cannot open the gate before the floor means anything.
const ADAPTIVE_WARMUP_SAMPLES = 30;
// Floor tracking: fall fast (quiet is believable immediately), rise slowly
// (speech bursts must not drag the floor up under themselves).
const FLOOR_DECAY = 0.3;
const FLOOR_RISE = 0.005;

export function detectVoiceActivityEvent({
  gate,
  micLevel,
  frame,
  motionStability,
  openLevel = DEFAULT_OPEN_LEVEL,
  closeLevel = DEFAULT_CLOSE_LEVEL,
  minEventSpacingMs = DEFAULT_MIN_EVENT_SPACING_MS,
}: VoiceActivityDetectionInput): VoiceActivityDetectionResult {
  if (!frame) {
    return { gate, event: null };
  }

  const noiseFloorLevel = updatedNoiseFloor(
    gate.noiseFloorLevel ?? null,
    micLevel,
  );
  const samplesSeen = (gate.samplesSeen ?? 0) + 1;
  const tracked: VoiceActivityGate = {
    ...gate,
    noiseFloorLevel,
    samplesSeen,
  };

  const warmed =
    samplesSeen >= ADAPTIVE_WARMUP_SAMPLES && noiseFloorLevel !== null;
  const adaptiveOpen = warmed
    ? Math.max(MIN_ADAPTIVE_OPEN_LEVEL, noiseFloorLevel * ADAPTIVE_OPEN_RATIO)
    : Number.POSITIVE_INFINITY;
  // The explicit absolute threshold still opens the gate (loud, close
  // speech); the adaptive threshold extends detection down to the quiet RMS
  // scale real phone captures actually produce.
  const effectiveOpen = Math.min(openLevel, adaptiveOpen);
  const adaptiveClose = warmed
    ? Math.max(
        MIN_ADAPTIVE_CLOSE_LEVEL,
        noiseFloorLevel * ADAPTIVE_CLOSE_RATIO,
      )
    : closeLevel;
  const effectiveClose = Math.min(closeLevel, adaptiveClose, effectiveOpen * 0.6);

  if (micLevel <= effectiveClose) {
    return {
      gate: { ...tracked, open: false },
      event: null,
    };
  }

  // Re-trigger during sustained speech on host-clock grid crossings: a long
  // utterance yields an event per grid tick, and because every device uses
  // the same grid their events cluster and cross-correlate instead of
  // free-running past each other.
  const canEmit =
    micLevel >= effectiveOpen &&
    (gate.lastEventHostEpochMs === null ||
      Math.floor(frame.hostEstimatedEpochMs / minEventSpacingMs) >
        Math.floor(gate.lastEventHostEpochMs / minEventSpacingMs));

  if (!canEmit) {
    return { gate: tracked, event: null };
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
    confidence: voiceConfidence(
      micLevel,
      effectiveOpen,
      frame.clockUncertaintyMs,
      motionStability,
    ),
    clockOffsetMs: frame.clockOffsetMs,
    clockUncertaintyMs: frame.clockUncertaintyMs,
    clockQuality: frame.clockQuality ?? null,
    clockMaxErrorMs: frame.clockMaxErrorMs ?? null,
    clockBestRoundTripMs: frame.clockBestRoundTripMs ?? null,
    clockJitterMs: frame.clockJitterMs ?? null,
    clockSamplesUsed: frame.clockSamplesUsed ?? null,
    clockOutliersRejected: frame.clockOutliersRejected ?? null,
    clockOffsetStabilityMs: frame.clockOffsetStabilityMs ?? null,
    timingConfidence: frame.timingConfidence,
    motionStability: motionStability ?? null,
  };

  return {
    gate: {
      ...tracked,
      open: true,
      lastEventHostEpochMs: frame.hostEstimatedEpochMs,
    },
    event,
  };
}

function updatedNoiseFloor(floor: number | null, micLevel: number) {
  if (!Number.isFinite(micLevel) || micLevel < 0) {
    return floor;
  }
  if (floor === null) {
    return micLevel;
  }
  if (micLevel < floor) {
    return floor * (1 - FLOOR_DECAY) + micLevel * FLOOR_DECAY;
  }
  return floor * (1 - FLOOR_RISE) + micLevel * FLOOR_RISE;
}

function voiceConfidence(
  micLevel: number,
  effectiveOpenLevel: number,
  clockUncertaintyMs: number,
  motionStability: number | null | undefined,
) {
  // Score loudness relative to the threshold that admitted the event, so a
  // clear voice on a quiet raw capture rates as well as a loud one on a hot
  // mic. The 1.78 factor reproduces the historical 0.045-open/0.08-reference
  // ratio.
  const levelScore = Math.max(
    0,
    Math.min(1, micLevel / (effectiveOpenLevel * 1.78)),
  );
  const timingScore = 1 / (1 + Math.max(0, clockUncertaintyMs) / 24);
  const motionScore =
    typeof motionStability === "number" && Number.isFinite(motionStability)
      ? 0.62 + Math.max(0, Math.min(1, motionStability)) * 0.38
      : 1;
  return round(Math.max(0.05, Math.min(1, levelScore * timingScore * motionScore)));
}

function round(value: number) {
  return Number(value.toFixed(3));
}
