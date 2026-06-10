"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SensorSnapshot } from "@/hooks/use-sensor-suite";
import {
  createClockProbeMessage,
  createRealtimeSensorFrame,
  parseRealtimeDataChannelMessage,
  serializeRealtimeDataChannelMessage,
} from "@/lib/realtime/data-channel";
import { selectRealtimePeerTargets } from "@/lib/realtime/coordinator";
import type {
  RealtimeDataChannelMessage,
  RealtimeSignal,
  RealtimeSignalPayload,
  RealtimeSensorFrameMessage,
} from "@/lib/realtime/contracts";
import type {
  AcousticObservation,
  AcousticPulse,
  RoomState,
} from "@/lib/session/registry";

type WebRtcRoomOptions = {
  active: boolean;
  deviceId: string;
  roomState: RoomState | null;
  snapshot: SensorSnapshot;
  getAcousticPulse?: () => AcousticPulse | null;
  getAcousticObservation?: () => AcousticObservation | null;
  onChirpSchedule?: (pulse: AcousticPulse) => void;
  onPulseObservation?: (observation: AcousticObservation) => void;
};

export type WebRtcRoomState = {
  supported: boolean;
  peerCount: number;
  openPeerCount: number;
  peerFrames: RealtimeSensorFrameMessage[];
};

type PeerRuntime = {
  peerId: string;
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
  lastClockProbeAt: number;
  clockProbeSequence: number;
  lastPulseId: string;
  lastObservationKey: string;
};

const SIGNAL_POLL_MS = 420;
const SENSOR_FRAME_MS = 220;
const CLOCK_PROBE_MS = 1_000;
const RECENT_PEER_FRAME_MS = 2_500;

export function useWebRtcRoom({
  active,
  deviceId,
  roomState,
  snapshot,
  getAcousticPulse,
  getAcousticObservation,
  onChirpSchedule,
  onPulseObservation,
}: WebRtcRoomOptions): WebRtcRoomState {
  const snapshotRef = useRef(snapshot);
  const getAcousticPulseRef = useRef(getAcousticPulse);
  const getAcousticObservationRef = useRef(getAcousticObservation);
  const onChirpScheduleRef = useRef(onChirpSchedule);
  const onPulseObservationRef = useRef(onPulseObservation);
  const peersRef = useRef(new Map<string, PeerRuntime>());
  const lastSignalSeqRef = useRef(0);
  const messageSequenceRef = useRef(0);
  const peerFramesRef = useRef<Record<string, RealtimeSensorFrameMessage>>({});
  const [peerFrames, setPeerFrames] = useState<RealtimeSensorFrameMessage[]>(
    [],
  );
  const [openPeerCount, setOpenPeerCount] = useState(0);
  const supported =
    typeof window !== "undefined" && "RTCPeerConnection" in window;
  const peerTargets = useMemo(
    () => selectRealtimePeerTargets(roomState, deviceId),
    [deviceId, roomState],
  );
  const targetKey = peerTargets.join("\u0000");
  const isHost = roomState?.hostDeviceId === deviceId;

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    getAcousticPulseRef.current = getAcousticPulse;
  }, [getAcousticPulse]);

  useEffect(() => {
    getAcousticObservationRef.current = getAcousticObservation;
  }, [getAcousticObservation]);

  useEffect(() => {
    onChirpScheduleRef.current = onChirpSchedule;
  }, [onChirpSchedule]);

  useEffect(() => {
    onPulseObservationRef.current = onPulseObservation;
  }, [onPulseObservation]);

  useEffect(() => {
    if (!active || !supported || !roomState) {
      closeAllPeers(peersRef.current);
      lastSignalSeqRef.current = 0;
      peerFramesRef.current = {};
      window.setTimeout(() => {
        setOpenPeerCount(0);
        setPeerFrames([]);
      }, 0);
      return;
    }

    const targetSet = new Set(peerTargets);
    closeRemovedPeers(peersRef.current, targetSet);
    for (const peerId of peerTargets) {
      if (!peersRef.current.has(peerId)) {
        void createPeerRuntime({
          deviceId,
          peerId,
          initiator: isHost,
          peers: peersRef.current,
          publishSignal,
          handleMessage,
          syncOpenPeerCount,
        });
      }
    }

    let cancelled = false;
    const poll = async () => {
      if (cancelled) {
        return;
      }
      await pollSignals({
        deviceId,
        targets: targetSet,
        peers: peersRef.current,
        lastSignalSeqRef,
        publishSignal,
        handleMessage,
        syncOpenPeerCount,
      });
    };
    void poll();
    const timer = window.setInterval(() => void poll(), SIGNAL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };

    async function publishSignal(
      toDeviceId: string,
      kind: RealtimeSignal["kind"],
      payload: RealtimeSignalPayload,
    ) {
      await postRealtimeSignal(toDeviceId, {
        fromDeviceId: deviceId,
        toDeviceId,
        kind,
        payload,
      }).catch(() => undefined);
    }

    function handleMessage(peerId: string, message: RealtimeDataChannelMessage) {
      if (message.type === "clock-probe") {
        sendDataChannelMessage(peersRef.current.get(peerId), {
          type: "clock-probe-ack",
          version: 1,
          id: message.id,
          fromDeviceId: deviceId,
          probeSentAtClientPerfMs: message.sentAtClientPerfMs,
          probeReceivedAtClientPerfMs: nowPerfMs(),
          ackSentAtClientPerfMs: nowPerfMs(),
          hostEstimatedEpochMs:
            snapshotRef.current.audioFrame?.hostEstimatedEpochMs ?? null,
        });
        return;
      }

      if (message.type === "sensor-frame") {
        peerFramesRef.current = {
          ...peerFramesRef.current,
          [message.fromDeviceId]: message,
        };
        setPeerFrames(recentPeerFrames(peerFramesRef.current));
        return;
      }

      if (message.type === "chirp-schedule") {
        onChirpScheduleRef.current?.(message.pulse);
        return;
      }

      if (message.type === "pulse-observation") {
        onPulseObservationRef.current?.(message.observation);
      }
    }

    function syncOpenPeerCount() {
      setOpenPeerCount(countOpenPeers(peersRef.current));
    }
  }, [active, deviceId, isHost, peerTargets, roomState, supported, targetKey]);

  useEffect(() => {
    if (!active || !supported) {
      return;
    }

    const sendFrames = () => {
      const sequence = messageSequenceRef.current + 1;
      messageSequenceRef.current = sequence;
      const sentAtClientPerfMs = nowPerfMs();
      const frame = createRealtimeSensorFrame({
        deviceId,
        sequence,
        sentAtClientPerfMs,
        snapshot: snapshotRef.current,
      });
      const pulse = getAcousticPulseRef.current?.() ?? null;
      const observation = getAcousticObservationRef.current?.() ?? null;

      for (const runtime of peersRef.current.values()) {
        sendDataChannelMessage(runtime, frame);
        maybeSendClockProbe(runtime, deviceId, sentAtClientPerfMs);
        if (pulse && runtime.lastPulseId !== pulse.id) {
          runtime.lastPulseId = pulse.id;
          sendDataChannelMessage(runtime, {
            type: "chirp-schedule",
            version: 1,
            fromDeviceId: deviceId,
            pulse,
          });
        }
        const observationKey = observation
          ? `${observation.pulseId}:${observation.detectedSampleIndex ?? ""}:${observation.detectedAtHostEpochMs}`
          : "";
        if (observation && observationKey !== runtime.lastObservationKey) {
          runtime.lastObservationKey = observationKey;
          sendDataChannelMessage(runtime, {
            type: "pulse-observation",
            version: 1,
            fromDeviceId: deviceId,
            observation,
          });
        }
      }
      setPeerFrames(recentPeerFrames(peerFramesRef.current));
    };

    sendFrames();
    const timer = window.setInterval(sendFrames, SENSOR_FRAME_MS);
    return () => window.clearInterval(timer);
  }, [active, deviceId, supported]);

  useEffect(
    () => () => {
      closeAllPeers(peersRef.current);
    },
    [],
  );

  return {
    supported,
    peerCount: peerTargets.length,
    openPeerCount,
    peerFrames,
  };
}

async function createPeerRuntime({
  deviceId,
  peerId,
  initiator,
  peers,
  publishSignal,
  handleMessage,
  syncOpenPeerCount,
}: {
  deviceId: string;
  peerId: string;
  initiator: boolean;
  peers: Map<string, PeerRuntime>;
  publishSignal: (
    toDeviceId: string,
    kind: RealtimeSignal["kind"],
    payload: RealtimeSignalPayload,
  ) => Promise<void>;
  handleMessage: (peerId: string, message: RealtimeDataChannelMessage) => void;
  syncOpenPeerCount: () => void;
}) {
  const connection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const runtime: PeerRuntime = {
    peerId,
    connection,
    channel: null,
    pendingCandidates: [],
    lastClockProbeAt: 0,
    clockProbeSequence: 0,
    lastPulseId: "",
    lastObservationKey: "",
  };
  peers.set(peerId, runtime);

  connection.onicecandidate = (event) => {
    const candidate = event.candidate?.toJSON();
    if (!candidate?.candidate) {
      return;
    }
    void publishSignal(peerId, "ice-candidate", {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null,
    });
  };
  connection.onconnectionstatechange = () => {
    if (
      connection.connectionState === "failed" ||
      connection.connectionState === "closed"
    ) {
      closePeer(peers, peerId);
    }
    syncOpenPeerCount();
  };
  connection.ondatachannel = (event) => {
    attachDataChannel(runtime, event.channel, handleMessage, syncOpenPeerCount);
  };

  if (!initiator) {
    return;
  }

  attachDataChannel(
    runtime,
    connection.createDataChannel(`blackmagic:${deviceId}:${peerId}`, {
      ordered: false,
      maxRetransmits: 1,
    }),
    handleMessage,
    syncOpenPeerCount,
  );
  await connection.setLocalDescription(await connection.createOffer());
  if (connection.localDescription?.sdp) {
    await publishSignal(peerId, "offer", {
      type: "offer",
      sdp: connection.localDescription.sdp,
    });
  }
}

function attachDataChannel(
  runtime: PeerRuntime,
  channel: RTCDataChannel,
  handleMessage: (peerId: string, message: RealtimeDataChannelMessage) => void,
  syncOpenPeerCount: () => void,
) {
  runtime.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.onopen = syncOpenPeerCount;
  channel.onclose = syncOpenPeerCount;
  channel.onerror = syncOpenPeerCount;
  channel.onmessage = (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    const message = parseRealtimeDataChannelMessage(event.data);
    if (message) {
      handleMessage(runtime.peerId, message);
    }
  };
}

async function pollSignals({
  deviceId,
  targets,
  peers,
  lastSignalSeqRef,
  publishSignal,
  handleMessage,
  syncOpenPeerCount,
}: {
  deviceId: string;
  targets: Set<string>;
  peers: Map<string, PeerRuntime>;
  lastSignalSeqRef: { current: number };
  publishSignal: (
    toDeviceId: string,
    kind: RealtimeSignal["kind"],
    payload: RealtimeSignalPayload,
  ) => Promise<void>;
  handleMessage: (peerId: string, message: RealtimeDataChannelMessage) => void;
  syncOpenPeerCount: () => void;
}) {
  const params = new URLSearchParams({
    url: window.location.href,
    deviceId,
    since: String(lastSignalSeqRef.current),
  });
  const response = await fetch(`/api/realtime/signals?${params.toString()}`, {
    cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) {
    return;
  }

  const body = (await response.json().catch(() => null)) as {
    signals?: RealtimeSignal[];
  } | null;
  const signals = body?.signals ?? [];
  for (const signal of signals) {
    lastSignalSeqRef.current = Math.max(lastSignalSeqRef.current, signal.seq);
    if (!targets.has(signal.fromDeviceId)) {
      continue;
    }
    let runtime = peers.get(signal.fromDeviceId);
    if (!runtime) {
      await createPeerRuntime({
        deviceId,
        peerId: signal.fromDeviceId,
        initiator: false,
        peers,
        publishSignal,
        handleMessage,
        syncOpenPeerCount,
      });
      runtime = peers.get(signal.fromDeviceId);
    }
    if (runtime) {
      await applyRealtimeSignal(runtime, signal, publishSignal);
    }
  }
}

async function applyRealtimeSignal(
  runtime: PeerRuntime,
  signal: RealtimeSignal,
  publishSignal: (
    toDeviceId: string,
    kind: RealtimeSignal["kind"],
    payload: RealtimeSignalPayload,
  ) => Promise<void>,
) {
  if (signal.kind === "offer" && "sdp" in signal.payload) {
    await runtime.connection.setRemoteDescription({
      type: "offer",
      sdp: signal.payload.sdp,
    });
    await flushPendingCandidates(runtime);
    await runtime.connection.setLocalDescription(
      await runtime.connection.createAnswer(),
    );
    if (runtime.connection.localDescription?.sdp) {
      await publishSignal(signal.fromDeviceId, "answer", {
        type: "answer",
        sdp: runtime.connection.localDescription.sdp,
      });
    }
    return;
  }

  if (signal.kind === "answer" && "sdp" in signal.payload) {
    if (!runtime.connection.remoteDescription) {
      await runtime.connection.setRemoteDescription({
        type: "answer",
        sdp: signal.payload.sdp,
      });
      await flushPendingCandidates(runtime);
    }
    return;
  }

  if (signal.kind === "ice-candidate" && "candidate" in signal.payload) {
    const candidate: RTCIceCandidateInit = {
      candidate: signal.payload.candidate,
      sdpMid: signal.payload.sdpMid ?? undefined,
      sdpMLineIndex: signal.payload.sdpMLineIndex ?? undefined,
      usernameFragment: signal.payload.usernameFragment ?? undefined,
    };
    if (!runtime.connection.remoteDescription) {
      runtime.pendingCandidates.push(candidate);
      return;
    }
    await runtime.connection.addIceCandidate(candidate).catch(() => undefined);
  }
}

async function flushPendingCandidates(runtime: PeerRuntime) {
  const pending = runtime.pendingCandidates.splice(0);
  for (const candidate of pending) {
    await runtime.connection.addIceCandidate(candidate).catch(() => undefined);
  }
}

async function postRealtimeSignal(
  toDeviceId: string,
  signal: Omit<RealtimeSignal, "seq" | "sessionKey" | "createdAt">,
) {
  await fetch("/api/realtime/signal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: window.location.href,
      signal: {
        ...signal,
        toDeviceId,
      },
    }),
  });
}

function sendDataChannelMessage(
  runtime: PeerRuntime | undefined,
  message: RealtimeDataChannelMessage,
) {
  if (!runtime?.channel || runtime.channel.readyState !== "open") {
    return false;
  }

  runtime.channel.send(serializeRealtimeDataChannelMessage(message));
  return true;
}

function maybeSendClockProbe(
  runtime: PeerRuntime,
  deviceId: string,
  sentAtClientPerfMs: number,
) {
  if (sentAtClientPerfMs - runtime.lastClockProbeAt < CLOCK_PROBE_MS) {
    return;
  }

  runtime.lastClockProbeAt = sentAtClientPerfMs;
  runtime.clockProbeSequence += 1;
  sendDataChannelMessage(
    runtime,
    createClockProbeMessage({
      id: `clock:${deviceId}:${runtime.peerId}:${runtime.clockProbeSequence}`,
      fromDeviceId: deviceId,
      sentAtClientPerfMs,
      hostEstimatedEpochMs: null,
    }),
  );
}

function closeRemovedPeers(
  peers: Map<string, PeerRuntime>,
  targetSet: Set<string>,
) {
  for (const peerId of peers.keys()) {
    if (!targetSet.has(peerId)) {
      closePeer(peers, peerId);
    }
  }
}

function closeAllPeers(peers: Map<string, PeerRuntime>) {
  for (const peerId of peers.keys()) {
    closePeer(peers, peerId);
  }
}

function closePeer(peers: Map<string, PeerRuntime>, peerId: string) {
  const runtime = peers.get(peerId);
  if (!runtime) {
    return;
  }

  runtime.channel?.close();
  runtime.connection.close();
  peers.delete(peerId);
}

function countOpenPeers(peers: Map<string, PeerRuntime>) {
  return [...peers.values()].filter(
    (runtime) => runtime.channel?.readyState === "open",
  ).length;
}

function recentPeerFrames(
  frames: Record<string, RealtimeSensorFrameMessage>,
) {
  const now = nowPerfMs();
  return Object.values(frames)
    .filter((frame) => now - frame.sentAtClientPerfMs <= RECENT_PEER_FRAME_MS)
    .sort((a, b) => a.fromDeviceId.localeCompare(b.fromDeviceId));
}

function nowPerfMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
