import type {
  AcousticObservation,
  AcousticPulse,
} from "../session/registry";
import type { VoiceActivityEvent } from "../session/audio-events";

export type RealtimeMode = "demo" | "provider";

export type RoomRole = "host" | "phone";

export type RoomPresence = {
  roomId: string;
  deviceId: string;
  role: RoomRole;
  joinedAt: number;
  lastSeenAt: number;
};

export type RoomSignal =
  | {
      type: "join" | "leave" | "heartbeat";
      presence: RoomPresence;
    }
  | {
      type: "sensor-frame";
      deviceId: string;
      at: number;
      micLevel: number;
      headingDegrees: number | null;
    }
  | {
      type: "calibration-range";
      from: string;
      to: string;
      meters: number;
      confidence: number;
    };

export type RealtimeConfig = {
  mode: RealtimeMode;
  provider: "ably" | "none";
  roomTtlSeconds: number;
};

export type RealtimeSignalKind = "offer" | "answer" | "ice-candidate";

export type RealtimeSdpSignalPayload = {
  type: "offer" | "answer";
  sdp: string;
};

export type RealtimeIceCandidateSignalPayload = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type RealtimeSignalPayload =
  | RealtimeSdpSignalPayload
  | RealtimeIceCandidateSignalPayload;

export type RealtimeSignalInput = {
  fromDeviceId: string;
  toDeviceId: string;
  kind: RealtimeSignalKind;
  payload: RealtimeSignalPayload;
};

export type RealtimeSignal = RealtimeSignalInput & {
  seq: number;
  sessionKey: string;
  createdAt: number;
};

export type RealtimeClockProbeMessage = {
  type: "clock-probe";
  version: 1;
  id: string;
  fromDeviceId: string;
  sentAtClientPerfMs: number;
  hostEstimatedEpochMs: number | null;
};

export type RealtimeClockProbeAckMessage = {
  type: "clock-probe-ack";
  version: 1;
  id: string;
  fromDeviceId: string;
  probeSentAtClientPerfMs: number;
  probeReceivedAtClientPerfMs: number;
  ackSentAtClientPerfMs: number;
  hostEstimatedEpochMs: number | null;
  // Receive/send instants in the responder's own wall-clock epoch domain
  // (performance.timeOrigin + performance.now()). When the responder is the
  // room host, these let a peer NTP-sync directly against the host clock over
  // the data channel instead of against a far-away HTTP server.
  probeReceivedAtEpochMs?: number | null;
  ackSentAtEpochMs?: number | null;
};

export type RealtimeWaveChunk = {
  // Host-epoch timestamp of the newest bucket; earlier buckets step back by
  // bucketMs each. Receivers merge chunks onto the shared host timeline.
  endHostEpochMs: number;
  bucketMs: number;
  levels: number[];
};

export type RealtimeSensorFrameMessage = {
  type: "sensor-frame";
  version: 1;
  fromDeviceId: string;
  sequence: number;
  sentAtClientPerfMs: number;
  hostEstimatedEpochMs: number | null;
  micLevel: number;
  wave?: RealtimeWaveChunk | null;
  sampleRate: number | null;
  headingDegrees: number | null;
  motionStability: number | null;
  motionRotationRateDegPerSec: number | null;
  motionCapturedAtClientPerfMs: number | null;
  clock: {
    offsetMs: number | null;
    uncertaintyMs: number | null;
    quality: number | null;
    maxErrorMs: number | null;
    bestRoundTripMs: number | null;
    jitterMs: number | null;
    samplesUsed: number | null;
    offsetStabilityMs: number | null;
    updatedAtClientPerfMs: number | null;
  } | null;
  audioFrame: {
    sampleIndex: number;
    sampleRate: number;
    hostEstimatedEpochMs: number;
    clockUncertaintyMs: number | null;
    timingConfidence: number | null;
  } | null;
  pulseObservation: AcousticObservation | null;
};

export type RealtimeChirpScheduleMessage = {
  type: "chirp-schedule";
  version: 1;
  fromDeviceId: string;
  pulse: AcousticPulse;
};

export type RealtimePulseObservationMessage = {
  type: "pulse-observation";
  version: 1;
  fromDeviceId: string;
  observation: AcousticObservation;
};

// One per detected voice event (min-spaced by the VAD), carrying the raw
// audio snippet the host's reconciliation engine cross-correlates. Kept out
// of the periodic sensor frames on purpose: frames repeat every ~220 ms and
// must stay snippet-free, while voice events are deduped by id.
export type RealtimeVoiceEventMessage = {
  type: "voice-event";
  version: 1;
  fromDeviceId: string;
  event: VoiceActivityEvent;
};

export type RealtimeReconciliationRange = {
  from: string;
  to: string;
  meters: number;
  uncertaintyMeters: number;
  // Convergence quality in [0, 1]; below ~0.5 the distance is still a lower
  // bound (the talker has not yet swept past the pair's endfire line).
  coverage: number;
  confidence: number;
  samplesUsed: number;
};

// Host → peers broadcast of the reconciliation result so every phone renders
// the same distances/constellation the host derived.
export type RealtimeReconciliationStateMessage = {
  type: "reconciliation-state";
  version: 1;
  fromDeviceId: string;
  updatedAtHostEpochMs: number;
  ranges: RealtimeReconciliationRange[];
  // Field diagnostics so any phone can show why ranging is (not) advancing:
  // retained voice events per device, GCC matches per pair.
  heardEvents: Array<{ deviceId: string; events: number }>;
  pairProgress: Array<{ from: string; to: string; observations: number }>;
  // Anchor-centered layout, present with 2+ ranged devices.
  points: Record<string, { x: number; y: number }> | null;
  layoutQuality: number | null;
  talker: {
    x: number;
    y: number;
    residualMs: number;
    confidence: number;
    atHostEpochMs: number;
  } | null;
};

// Host → peers: start/stop a synchronized full-resolution capture session.
// Every device records its own stream locally and uploads when stopped.
export type RealtimeRecordControlMessage = {
  type: "record-control";
  version: 1;
  fromDeviceId: string;
  recordingId: string;
  action: "start" | "stop";
};

// Any device → room: progress of its recording upload, so the host screen
// can confirm every stream landed in the cloud.
export type RealtimeRecordingStatusMessage = {
  type: "recording-status";
  version: 1;
  fromDeviceId: string;
  recordingId: string;
  state: "recording" | "uploading" | "uploaded" | "failed";
  url: string | null;
  detail: string | null;
};

export type RealtimeDataChannelMessage =
  | RealtimeClockProbeMessage
  | RealtimeClockProbeAckMessage
  | RealtimeSensorFrameMessage
  | RealtimeChirpScheduleMessage
  | RealtimePulseObservationMessage
  | RealtimeVoiceEventMessage
  | RealtimeReconciliationStateMessage
  | RealtimeRecordControlMessage
  | RealtimeRecordingStatusMessage;
