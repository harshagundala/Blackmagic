import type {
  AcousticObservation,
  AcousticPulse,
} from "../session/registry";

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

export type RealtimeSensorFrameMessage = {
  type: "sensor-frame";
  version: 1;
  fromDeviceId: string;
  sequence: number;
  sentAtClientPerfMs: number;
  hostEstimatedEpochMs: number | null;
  micLevel: number;
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

export type RealtimeDataChannelMessage =
  | RealtimeClockProbeMessage
  | RealtimeClockProbeAckMessage
  | RealtimeSensorFrameMessage
  | RealtimeChirpScheduleMessage
  | RealtimePulseObservationMessage;
