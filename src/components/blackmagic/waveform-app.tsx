"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomSession } from "@/hooks/use-room-session";
import { useStaleBuildReload } from "@/hooks/use-stale-build-reload";
import {
  useSensorSuite,
  type CaptureConstraintMode,
  type SensorSnapshot,
} from "@/hooks/use-sensor-suite";
import { useWebRtcRoom } from "@/hooks/use-webrtc-room";
import { WaveSeries } from "@/lib/waveform/wave-series";
import { projectClockModel } from "@/lib/timing/clock-sync";
import type {
  RealtimeReconciliationStateMessage,
  RealtimeRecordControlMessage,
  RealtimeRecordingStatusMessage,
  RealtimeSensorFrameMessage,
} from "@/lib/realtime/contracts";
import { uploadRecordedTake } from "@/lib/recording/upload";
import { roomStatePollingIntervalMs } from "@/lib/session/polling";
import type { DeviceTimeSyncState } from "@/lib/session/timing-health";
import {
  ReconciliationEngine,
  type ReconciliationSnapshot,
} from "@/lib/reconciliation/engine";
import { MIN_RANGE_SAMPLES as RANGE_TARGET_SAMPLES } from "@/lib/reconciliation/pair-tdoa-history";
import type { VoiceActivityEvent } from "@/lib/session/audio-events";
import { hasPulseLead } from "@/lib/calibration/cadence";
import {
  MIN_ULTRASONIC_CAPTURE_RATE_HZ,
  ULTRASONIC_CHIRP_GAIN,
  chirpBandFor,
} from "@/lib/calibration/chirp-lanes";
import {
  captureRateIsNarrowband,
  shouldAutoPromoteRawCapture,
} from "@/lib/acoustics/capture-health";
import {
  createMatchedToneObservation,
  createScheduledAcousticPulse,
} from "@/lib/calibration/pulse";
import {
  createPulseToneScheduler,
  type PulseToneScheduler,
} from "@/lib/calibration/playback";
import {
  clearEdgeEvidenceForDevice,
  createEdgeEvidence,
  deriveEdgeRanges,
  recordEdgeObservation,
  recordEdgePulse,
} from "@/lib/realtime/edge-reconciliation";
import { selectUpcomingCalibrationTurn } from "@/lib/calibration/session";
import type {
  AcousticObservation,
  AcousticPulse,
  RoomDevice,
} from "@/lib/session/registry";

type Phase = "arriving" | "listening";

// Chirp rotation: tight slots so a two-phone reciprocal exchange completes
// in under four seconds of joining; the lead still covers data-channel
// delivery of the schedule before the tone plays.
const MIN_CHIRP_LEAD_MS = 550;
const CHIRP_TURN_POLL_MS = 400;
// 200 ms sweeps: near-ultrasonic receptions are transducer-rolloff-limited,
// and matched-filter gain grows with duration (~4 dB over the original
// 80 ms). The pulse plus search margins must still fit the 1 s rolling
// capture window when the fallback search runs ~250 ms after arrival.
const CHIRP_TURN_OPTIONS = {
  slotDurationMs: 1_800,
  pulseOffsetMs: 1_000,
  minLeadMs: 700,
  pulseDurationMs: 200,
};
// How many times the matched-filter fallback may re-search the rolling
// window for one pulse; it is main-thread DSP, so unbounded retries at
// render cadence freeze the UI.
const MAX_MATCH_ATTEMPTS_PER_PULSE = 2;

// The trailing window each row renders, and how far behind "now" the right
// edge sits so remote chunks (sent every ~220 ms) have arrived by the time
// their timeline position scrolls into view.
const WAVE_WINDOW_MS = 4_000;
const WAVE_RENDER_LAG_MS = 650;
const WAVE_RENDER_BUCKETS = 220;
const STALE_WAVE_MS = 2_200;

export function WaveformApp() {
  const [phase, setPhase] = useState<Phase>("arriving");
  const { deviceId, heartbeat, roomState, connection } = useRoomSession({
    pollIntervalMs: roomStatePollingIntervalMs({
      listening: phase === "listening",
    }),
    // Joining (and possibly winning the host role) must wait for the tap:
    // a merely-opened tab that claims the room strands real phones on a
    // host with no capture or clock.
    join: phase === "listening",
  });
  const sensors = useSensorSuite();
  const offerClockExchange = sensors.offerClockExchange;
  const setClockAuthority = sensors.setClockAuthority;
  const snapshotRef = useRef(sensors.snapshot);
  const peerSeriesRef = useRef(new Map<string, WaveSeries>());
  const canvasesRef = useRef(new Map<string, HTMLCanvasElement>());

  // Reconciliation runs on the host node only: peers stream their voice
  // events (with raw-audio snippets) to the host, the host cross-correlates
  // them into distances/positions and broadcasts the result back.
  const isHost = roomState?.hostDeviceId === deviceId;
  const isHostRef = useRef(isHost);
  const reconciliationEngineRef = useRef<ReconciliationEngine | null>(null);
  const reconciliationMessageRef =
    useRef<RealtimeReconciliationStateMessage | null>(null);
  const [reconciliation, setReconciliation] =
    useState<RealtimeReconciliationStateMessage | null>(null);

  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  const hostEngine = useCallback(() => {
    if (!reconciliationEngineRef.current) {
      reconciliationEngineRef.current = new ReconciliationEngine();
    }
    return reconciliationEngineRef.current;
  }, []);

  // Active chirp bootstrap: phones take deterministic host-clock turns
  // emitting short near-ultrasonic sweeps; every phone records every chirp
  // in its own sample stream, and reciprocal pairs yield instant, clock-free
  // distances (BeepBeep-style) — no talker movement needed. Passive ambient
  // ranging keeps refining alongside.
  const edgeEvidenceRef = useRef(createEdgeEvidence());
  const publishedPulseIdRef = useRef("");
  const activePulseRef = useRef<AcousticPulse | null>(null);
  const observablePulseRef = useRef<AcousticPulse | null>(null);
  const lastObservationRef = useRef<AcousticObservation | null>(null);
  const pulseSchedulerRef = useRef<PulseToneScheduler | null>(null);
  const matchAttemptsRef = useRef(new Map<string, number>());
  const roomDevicesRef = useRef<RoomDevice[]>([]);
  // Chirps loud enough to range with are loud enough to trip the voice gate;
  // every scheduled pulse opens a suppression window so chirps never
  // masquerade as voice events.
  const recentPulsesRef = useRef<AcousticPulse[]>([]);

  // Self-hearing health: a phone hears its own chirp from ~10 cm every turn,
  // so consecutive misses mean ITS output or capture is degraded (media
  // volume down, blocked ports, a case) — a state that silently kills
  // reciprocal ranging for the whole room and that only this phone can
  // detect. Field case: one phone's volume was lowered and the room never
  // ranged again, with zero indication why.
  const ownChirpLogRef = useRef<Array<{ id: string; deadlineEpochMs: number }>>([]);
  const heardOwnChirpIdsRef = useRef<Set<string>>(new Set());
  const [cannotHearOwnChirps, setCannotHearOwnChirps] = useState(false);
  const updateOwnChirpHealth = useCallback((nowEpochMs: number) => {
    const expired = ownChirpLogRef.current.filter(
      (entry) => entry.deadlineEpochMs <= nowEpochMs,
    );
    if (expired.length < 2) {
      return;
    }
    const lastTwo = expired.slice(-2);
    setCannotHearOwnChirps(
      lastTwo.every((entry) => !heardOwnChirpIdsRef.current.has(entry.id)),
    );
  }, []);

  const noteRecentPulse = useCallback((pulse: AcousticPulse) => {
    recentPulsesRef.current = [...recentPulsesRef.current.slice(-7), pulse];
  }, []);

  const isChirpWindow = useCallback((hostEpochMs: number) => {
    return recentPulsesRef.current.some(
      (pulse) =>
        hostEpochMs >= pulse.emittedAtHostEpochMs - 150 &&
        hostEpochMs <= pulse.emittedAtHostEpochMs + pulse.durationMs + 350,
    );
  }, []);

  // Sustained movement of a device invalidates its chirp evidence: the next
  // reciprocal exchange re-measures from scratch (the engine's passive
  // histories reset through engine.noteMotion separately).
  const motionStreakRef = useRef(new Map<string, number>());
  const noteChirpMotion = useCallback(
    (motionDeviceId: string, stability: number | null, atHostEpochMs: number) => {
      if (typeof stability !== "number" || !Number.isFinite(atHostEpochMs)) {
        return;
      }
      if (stability >= 0.35) {
        motionStreakRef.current.delete(motionDeviceId);
        return;
      }
      const start = motionStreakRef.current.get(motionDeviceId);
      if (start === undefined) {
        motionStreakRef.current.set(motionDeviceId, atHostEpochMs);
      } else if (atHostEpochMs - start >= 600) {
        clearEdgeEvidenceForDevice(edgeEvidenceRef.current, motionDeviceId);
      }
    },
    [],
  );

  useEffect(() => {
    roomDevicesRef.current = roomState?.devices ?? [];
  }, [roomState?.devices]);

  const setVoiceEventGate = sensors.setVoiceEventGate;
  useEffect(() => {
    setVoiceEventGate((hostEpochMs) => !isChirpWindow(hostEpochMs));
    return () => setVoiceEventGate(null);
  }, [isChirpWindow, setVoiceEventGate]);

  const recordChirpEvidence = useCallback(
    (
      fromDeviceId: string,
      pulse: AcousticPulse | null,
      observation: AcousticObservation | null,
    ) => {
      let changed = false;
      if (pulse) {
        changed = recordEdgePulse(edgeEvidenceRef.current, fromDeviceId, pulse) || changed;
      }
      if (observation) {
        changed =
          recordEdgeObservation(edgeEvidenceRef.current, fromDeviceId, observation) ||
          changed;
      }
      if (changed && isHostRef.current) {
        const nowMs = hostEpochNow(snapshotRef.current);
        if (nowMs !== null) {
          // Tight freshness so the map follows a moving phone instead of
          // averaging across where it used to be.
          for (const range of deriveEdgeRanges(edgeEvidenceRef.current, {
            hostEpochNowMs: nowMs,
            maxRangeAgeMs: 10_000,
          })) {
            hostEngine().setSeedRange({
              from: range.from,
              to: range.to,
              method: "chirp",
              meters: range.meters,
              uncertaintyMeters: Math.max(
                0.03,
                range.distanceUncertaintyMeters,
              ),
              biasMs: 0,
              driftMsPerSecond: 0,
              coverage: 1,
              samplesUsed: range.samplesUsed,
              confidence: range.confidence,
              observedAtHostEpochMs: range.observedAtHostEpochMs,
            });
          }
        }
      }
    },
    [hostEngine],
  );

  // Ground-truth recording sessions: the host's record button starts a
  // synchronized full-resolution capture on every phone; on stop each phone
  // uploads its own WAV + metadata sidecar to Blob storage and reports
  // progress over the data channel.
  const [activeRecording, setActiveRecording] = useState<{
    id: string;
    startedAtPerfMs: number;
  } | null>(null);
  const activeRecordingRef = useRef(activeRecording);

  // A tab left open across a deploy silently breaks the room (mismatched
  // chirp parameters between versions); reload it as soon as it is safe.
  useStaleBuildReload({ holdReload: activeRecording !== null });
  const [recordingStatuses, setRecordingStatuses] = useState<
    Record<string, RealtimeRecordingStatusMessage>
  >({});
  const recordControlRef = useRef<RealtimeRecordControlMessage | null>(null);
  const recordingStatusRef = useRef<RealtimeRecordingStatusMessage | null>(null);
  const sessionKeyRef = useRef<string>("room");

  useEffect(() => {
    activeRecordingRef.current = activeRecording;
  }, [activeRecording]);

  useEffect(() => {
    if (roomState?.sessionKey) {
      sessionKeyRef.current = roomState.sessionKey;
    }
  }, [roomState?.sessionKey]);

  const publishRecordingStatus = useCallback(
    (
      recordingId: string,
      state: RealtimeRecordingStatusMessage["state"],
      url: string | null,
      detail: string | null,
    ) => {
      const message: RealtimeRecordingStatusMessage = {
        type: "recording-status",
        version: 1,
        fromDeviceId: deviceId,
        recordingId,
        state,
        url,
        detail,
      };
      recordingStatusRef.current = message;
      setRecordingStatuses((current) => ({ ...current, [deviceId]: message }));
    },
    [deviceId],
  );

  const finishRecording = useCallback(
    async (recordingId: string) => {
      const take = sensors.stopRecording();
      if (!take || take.recordingId !== recordingId) {
        publishRecordingStatus(recordingId, "failed", null, "no audio captured");
        return;
      }
      publishRecordingStatus(recordingId, "uploading", null, null);
      try {
        const snapshot = snapshotRef.current;
        const result = await uploadRecordedTake(take, {
          deviceId,
          sessionKey: sessionKeyRef.current,
          sessionUrl: window.location.href,
          role: isHostRef.current ? "host" : "phone",
          sampleRateReported: snapshot.sampleRate,
          captureMode: snapshot.captureMode,
          clock: snapshot.clock
            ? {
                offsetMs: snapshot.clock.offsetMs,
                uncertaintyMs: snapshot.clock.uncertaintyMs,
                maxErrorMs: snapshot.clock.maxErrorMs,
                samplesUsed: snapshot.clock.samplesUsed,
              }
            : null,
        });
        publishRecordingStatus(recordingId, "uploaded", result.wavUrl, null);
      } catch (error) {
        publishRecordingStatus(
          recordingId,
          "failed",
          null,
          error instanceof Error ? error.message.slice(0, 120) : "upload failed",
        );
      }
    },
    [deviceId, publishRecordingStatus, sensors],
  );

  const toggleRecording = useCallback(() => {
    if (!isHostRef.current) {
      return;
    }
    const current = activeRecordingRef.current;
    if (!current) {
      const id = `take-${crypto.randomUUID().slice(0, 8)}`;
      recordControlRef.current = {
        type: "record-control",
        version: 1,
        fromDeviceId: deviceId,
        recordingId: id,
        action: "start",
      };
      sensors.startRecording(id);
      setActiveRecording({ id, startedAtPerfMs: performance.now() });
      setRecordingStatuses({});
      publishRecordingStatus(id, "recording", null, null);
    } else {
      recordControlRef.current = {
        type: "record-control",
        version: 1,
        fromDeviceId: deviceId,
        recordingId: current.id,
        action: "stop",
      };
      setActiveRecording(null);
      void finishRecording(current.id);
    }
  }, [deviceId, finishRecording, publishRecordingStatus, sensors]);



  const realtime = useWebRtcRoom({
    active: phase === "listening",
    deviceId,
    roomState,
    snapshot: sensors.snapshot,
    getWaveChunk: sensors.getWaveChunk,
    getVoiceEvent: useCallback(() => {
      const event = snapshotRef.current.voiceEvent;
      if (!event || isChirpWindow(event.detectedAtHostEpochMs)) {
        return null;
      }
      return event;
    }, [isChirpWindow]),
    getReconciliationState: useCallback(
      () => reconciliationMessageRef.current,
      [],
    ),
    onVoiceEvent: useCallback(
      (event: VoiceActivityEvent, fromDeviceId: string) => {
        if (
          isHostRef.current &&
          !isChirpWindow(event.detectedAtHostEpochMs)
        ) {
          hostEngine().ingestVoiceEvent(fromDeviceId, event);
        }
      },
      [hostEngine, isChirpWindow],
    ),
    onReconciliationState: useCallback(
      (state: RealtimeReconciliationStateMessage) => {
        if (!isHostRef.current) {
          setReconciliation(state);
        }
      },
      [],
    ),
    getAcousticPulse: useCallback(() => activePulseRef.current, []),
    getAcousticObservation: useCallback(() => lastObservationRef.current, []),
    onChirpSchedule: useCallback(
      (pulse: AcousticPulse, fromDeviceId: string) => {
        recordChirpEvidence(fromDeviceId, pulse, null);
        noteRecentPulse(pulse);
        const nowMs = hostEpochNow(snapshotRef.current);
        if (nowMs === null) {
          return;
        }
        const deltaMs = pulse.emittedAtHostEpochMs - nowMs;
        if (
          deltaMs > -200 &&
          deltaMs < 5_500 &&
          observablePulseRef.current?.id !== pulse.id
        ) {
          // Armed for the bounded matched-filter search after arrival; the
          // continuous streaming matcher stays off (main-thread cost).
          observablePulseRef.current = pulse;
        }
      },
      [noteRecentPulse, recordChirpEvidence],
    ),
    onPulseObservation: useCallback(
      (observation: AcousticObservation, fromDeviceId: string) => {
        recordChirpEvidence(fromDeviceId, null, observation);
      },
      [recordChirpEvidence],
    ),
    getRecordControl: useCallback(() => recordControlRef.current, []),
    getRecordingStatus: useCallback(() => recordingStatusRef.current, []),
    onRecordControl: useCallback(
      (message: RealtimeRecordControlMessage) => {
        if (isHostRef.current) {
          return;
        }
        if (message.action === "start") {
          if (activeRecordingRef.current?.id !== message.recordingId) {
            sensors.startRecording(message.recordingId);
            setActiveRecording({
              id: message.recordingId,
              startedAtPerfMs: performance.now(),
            });
            publishRecordingStatus(message.recordingId, "recording", null, null);
          }
        } else if (activeRecordingRef.current?.id === message.recordingId) {
          setActiveRecording(null);
          void finishRecording(message.recordingId);
        }
      },
      [finishRecording, publishRecordingStatus, sensors],
    ),
    onRecordingStatus: useCallback(
      (message: RealtimeRecordingStatusMessage) => {
        setRecordingStatuses((current) => ({
          ...current,
          [message.fromDeviceId]: message,
        }));
      },
      [],
    ),
    onClockExchange: offerClockExchange,
  });

  useEffect(() => {
    snapshotRef.current = sensors.snapshot;
  }, [sensors.snapshot]);

  // The first connected device is the host; its clock is the timeline every
  // waveform is drawn against.
  useEffect(() => {
    if (!roomState?.hostDeviceId) {
      return;
    }
    setClockAuthority(roomState.hostDeviceId === deviceId ? "self" : "external");
  }, [deviceId, roomState?.hostDeviceId, setClockAuthority]);

  const begin = useCallback(async () => {
    if (phase === "listening") {
      if (snapshotRef.current.mic === "blocked") {
        await sensors.start();
      }
      return;
    }
    setPhase("listening");
    await sensors.start();
  }, [phase, sensors]);

  useEffect(() => {
    if (phase !== "listening") {
      return;
    }
    void heartbeat(snapshotRef.current);
    const timer = window.setInterval(
      () => void heartbeat(snapshotRef.current),
      1_500,
    );
    return () => window.clearInterval(timer);
  }, [heartbeat, phase]);

  // Merge incoming peer wave chunks onto each device's series; prune devices
  // that left the room.
  useEffect(() => {
    for (const frame of realtime.peerFrames) {
      if (!frame.wave) {
        continue;
      }
      let series = peerSeriesRef.current.get(frame.fromDeviceId);
      if (!series) {
        series = new WaveSeries();
        peerSeriesRef.current.set(frame.fromDeviceId, series);
      }
      series.appendChunk(frame.wave);
    }

    const present = new Set(
      (roomState?.devices ?? []).map((device) => device.deviceId),
    );
    for (const id of peerSeriesRef.current.keys()) {
      if (!present.has(id)) {
        peerSeriesRef.current.delete(id);
        reconciliationEngineRef.current?.removeDevice(id);
      }
    }
  }, [realtime.peerFrames, roomState?.devices]);

  // A phone's motion stability gates its acoustic evidence — a phone that
  // moved invalidates the distances it took part in (chirp evidence on every
  // device, passive histories on the host).
  useEffect(() => {
    for (const frame of realtime.peerFrames) {
      if (
        frame.motionStability !== null &&
        frame.hostEstimatedEpochMs !== null
      ) {
        noteChirpMotion(
          frame.fromDeviceId,
          frame.motionStability,
          frame.hostEstimatedEpochMs,
        );
        if (isHost) {
          hostEngine().noteMotion(
            frame.fromDeviceId,
            frame.motionStability,
            frame.hostEstimatedEpochMs,
          );
        }
      }
    }
  }, [hostEngine, isHost, noteChirpMotion, realtime.peerFrames]);

  // Host: feed its own voice events into the engine as they fire.
  const ownVoiceEvent = sensors.snapshot.voiceEvent;
  useEffect(() => {
    if (
      isHost &&
      ownVoiceEvent &&
      !isChirpWindow(ownVoiceEvent.detectedAtHostEpochMs)
    ) {
      hostEngine().ingestVoiceEvent(deviceId, ownVoiceEvent);
    }
  }, [deviceId, hostEngine, isChirpWindow, isHost, ownVoiceEvent]);

  // Chirp ranging needs voice processing off: AEC deletes this phone's own
  // chirp from its capture (no self-anchor, so no reciprocal range) and NS
  // attenuates the near-ultrasonic lanes. Once a multi-device room is live
  // on the default processed capture, try the raw pipeline once per session
  // — without persisting it: the silence watchdog demotes back to processed
  // within seconds when raw capture is dead on this device, and a raw
  // capture that proves healthy persists itself as the known-good mode.
  const autoRawAttemptedRef = useRef(false);
  const captureSnapshot = sensors.snapshot;
  const requestCaptureMode = sensors.requestCaptureMode;
  const roomDeviceCount = roomState?.devices?.length ?? 0;
  useEffect(() => {
    if (
      phase !== "listening" ||
      autoRawAttemptedRef.current ||
      !shouldAutoPromoteRawCapture({
        mic: captureSnapshot.mic,
        audioContextState: captureSnapshot.audioContextState,
        captureMode: captureSnapshot.captureMode,
        rawCaptureVerified:
          captureSnapshot.captureProcessing?.rawCaptureVerified ?? false,
        roomDeviceCount,
      })
    ) {
      return;
    }
    autoRawAttemptedRef.current = true;
    requestCaptureMode("raw", { persist: false });
  }, [
    captureSnapshot.audioContextState,
    captureSnapshot.captureMode,
    captureSnapshot.captureProcessing,
    captureSnapshot.mic,
    phase,
    requestCaptureMode,
    roomDeviceCount,
  ]);

  // Chirp emitter rotation: every capturing device computes the same
  // host-clock turn schedule; on its turn it announces the pulse over the
  // data channel, listens for itself, and plays it through the capture
  // context (created in the tap gesture — an iOS requirement).
  useEffect(() => {
    if (phase !== "listening" || !roomState) {
      return;
    }
    const emit = () => {
      const nowMs = hostEpochNow(snapshotRef.current);
      if (nowMs === null) {
        return;
      }
      // Only devices that are actually capturing take emitter turns: a
      // suspended phone cannot self-record its chirp, and one capturing
      // below the ultrasonic Nyquist cannot self-anchor an inaudible sweep.
      const capableIds = roomDevicesRef.current
        .filter(
          (device) =>
            device.mic === "active" &&
            device.audioFrame &&
            (typeof device.sampleRate !== "number" ||
              device.sampleRate >= MIN_ULTRASONIC_CAPTURE_RATE_HZ),
        )
        .map((device) => device.deviceId);
      const turn = selectUpcomingCalibrationTurn(
        capableIds,
        nowMs,
        CHIRP_TURN_OPTIONS,
      );
      if (!turn || turn.emitterId !== deviceId) {
        return;
      }
      const pulse = createScheduledAcousticPulse({
        deviceId,
        sequence: turn.sequence,
        hostEpochNowMs: nowMs,
        leadMs: turn.pulseEmittedAtHostEpochMs - nowMs,
        durationMs: turn.pulseDurationMs,
        ...chirpBandFor(deviceId),
      });
      if (
        !hasPulseLead(pulse, nowMs, MIN_CHIRP_LEAD_MS) ||
        pulse.id === publishedPulseIdRef.current
      ) {
        return;
      }
      publishedPulseIdRef.current = pulse.id;
      activePulseRef.current = pulse;
      observablePulseRef.current = pulse;
      noteRecentPulse(pulse);
      recordChirpEvidence(deviceId, pulse, null);
      ownChirpLogRef.current = [
        ...ownChirpLogRef.current.slice(-5),
        {
          id: pulse.id,
          // Past this point the matched-filter fallback has had both its
          // bounded attempts; an unheard pulse is genuinely unheard.
          deadlineEpochMs:
            pulse.emittedAtHostEpochMs + pulse.durationMs + 1_500,
        },
      ];
      scheduleOutputPulse(
        pulse,
        snapshotRef.current,
        pulseSchedulerRef,
        sensors.getAudioContext,
      );
    };
    const emitAndCheck = () => {
      emit();
      const nowMs = hostEpochNow(snapshotRef.current);
      if (nowMs !== null) {
        updateOwnChirpHealth(nowMs);
      }
    };
    emitAndCheck();
    const timer = window.setInterval(emitAndCheck, CHIRP_TURN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [
    deviceId,
    noteRecentPulse,
    phase,
    recordChirpEvidence,
    updateOwnChirpHealth,
    roomState,
    sensors.getAudioContext,
  ]);

  useEffect(
    () => () => {
      void pulseSchedulerRef.current?.close();
      pulseSchedulerRef.current = null;
    },
    [],
  );

  // Own chirp detections: prefer the streaming matcher's hit; when it
  // missed, re-search the rolling audio window around the pulse's expected
  // arrival with the matched-filter fallback. The fallback is main-thread
  // DSP, so it is strictly bounded: only after the pulse has fully arrived,
  // and at most twice per pulse — unbounded retries at snapshot cadence
  // freeze the UI and starve audio scheduling.
  const ownPulseObservation = sensors.snapshot.pulseObservation;
  useEffect(() => {
    if (phase !== "listening") {
      return;
    }
    const pulse = observablePulseRef.current;
    let observation =
      ownPulseObservation && (!pulse || ownPulseObservation.pulseId === pulse.id)
        ? ownPulseObservation
        : null;

    if (!observation && pulse) {
      const nowMs = hostEpochNow(snapshotRef.current);
      const attempts = matchAttemptsRef.current.get(pulse.id) ?? 0;
      const arrived =
        nowMs !== null &&
        nowMs >= pulse.emittedAtHostEpochMs + pulse.durationMs + 250;
      if (
        arrived &&
        attempts < MAX_MATCH_ATTEMPTS_PER_PULSE &&
        lastObservationRef.current?.pulseId !== pulse.id
      ) {
        matchAttemptsRef.current.set(pulse.id, attempts + 1);
        if (matchAttemptsRef.current.size > 32) {
          const oldest = matchAttemptsRef.current.keys().next().value;
          if (oldest !== undefined) {
            matchAttemptsRef.current.delete(oldest);
          }
        }
        observation = maybeCreateMatchedObservation(
          pulse,
          snapshotRef.current,
          lastObservationRef.current?.pulseId ?? "",
        );
      }
    }

    if (!observation) {
      return;
    }
    lastObservationRef.current = observation;
    // Only an observation of one of OUR pulses proves this phone can hear
    // itself — hearing a peer's chirp says nothing about our own output.
    if (ownChirpLogRef.current.some((entry) => entry.id === observation.pulseId)) {
      heardOwnChirpIdsRef.current.add(observation.pulseId);
      setCannotHearOwnChirps(false);
    }
    recordChirpEvidence(deviceId, null, observation);
  }, [deviceId, ownPulseObservation, phase, recordChirpEvidence, sensors.snapshot]);

  // Host: recompute the room geometry about once a second and stage the
  // result for broadcast; peers receive it via onReconciliationState.
  useEffect(() => {
    if (phase !== "listening" || !isHost) {
      reconciliationMessageRef.current = null;
      return;
    }
    const tick = () => {
      const nowMs = hostEpochNow(snapshotRef.current) ?? Date.now();
      const engine = hostEngine();
      engine.setAnchorDevice(deviceId);
      engine.setRoomDevices(
        roomDevicesRef.current.map((device) => device.deviceId),
      );
      noteChirpMotion(deviceId, snapshotRef.current.motionStability, nowMs);
      engine.noteMotion(deviceId, snapshotRef.current.motionStability, nowMs);
      const message = reconciliationStateMessage(
        deviceId,
        engine.snapshot(nowMs),
      );
      reconciliationMessageRef.current = message;
      setReconciliation(message);
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [deviceId, hostEngine, isHost, noteChirpMotion, phase]);

  // One render loop draws every row from its series, aligned on the shared
  // host-clock timeline.
  useEffect(() => {
    if (phase !== "listening") {
      return;
    }

    let frame = 0;
    const draw = () => {
      const endMs =
        (hostEpochNow(snapshotRef.current) ?? Date.now()) - WAVE_RENDER_LAG_MS;
      for (const [id, canvas] of canvasesRef.current) {
        const series =
          id === deviceId
            ? sensors.getWaveSeries()
            : peerSeriesRef.current.get(id) ?? null;
        drawWaveRow(canvas, series, endMs);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [deviceId, phase, sensors]);

  const registerCanvas = useCallback(
    (id: string) => (canvas: HTMLCanvasElement | null) => {
      if (canvas) {
        canvasesRef.current.set(id, canvas);
      } else {
        canvasesRef.current.delete(id);
      }
    },
    [],
  );

  const listening = phase === "listening";
  const devices = roomState?.devices ?? [];
  const peerCount = Math.max(0, devices.length - 1);
  const syncByDevice = new Map(
    (roomState?.timeSync.devices ?? []).map((device) => [
      device.deviceId,
      device,
    ]),
  );
  const frameByDevice = new Map(
    realtime.peerFrames.map((frame) => [frame.fromDeviceId, frame]),
  );
  const nowHostMs = hostEpochNow(sensors.snapshot);
  const reconnecting = connection === "reconnecting";

  return (
    <main
      aria-label="Blackmagic waveform session"
      className="relative min-h-dvh cursor-default overflow-hidden bg-white text-[#05060a] [touch-action:manipulation]"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          void begin();
        }
      }}
      onPointerDown={() => void begin()}
      role="button"
      tabIndex={0}
    >
      <header
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between px-6 pt-[max(20px,env(safe-area-inset-top))] font-mono text-[10px] uppercase tracking-[0.14em] text-black/45 transition-opacity duration-700"
        style={{ opacity: listening ? 1 : 0 }}
      >
        <span>
          {reconnecting
            ? "reconnecting"
            : peerCount === 0
              ? "alone so far"
              : `${peerCount + 1} phones · ${
                  realtime.openPeerCount > 0
                    ? `${realtime.openPeerCount} direct ${
                        realtime.openPeerCount === 1 ? "link" : "links"
                      }`
                    : "linking"
                }`}
        </span>
        <span className="flex flex-col items-end gap-1 text-right">
          <span>{isHost ? "hosting" : describeOwnSync(sensors.snapshot)}</span>
          {iosNonSafariBrowser() ? (
            <span className="text-[#b45309]">
              {`ios ${iosNonSafariBrowser()} limits mic capture — use safari`}
            </span>
          ) : null}
          {sensors.snapshot.mic === "blocked" ? (
            <span className="text-[#b45309]">mic off — tap to enable</span>
          ) : sensors.snapshot.trackMuted ? (
            <span className="text-[#b45309]">mic muted by ios</span>
          ) : sensors.snapshot.audioContextState &&
            sensors.snapshot.audioContextState !== "running" ? (
            <span className="text-[#b45309]">audio paused — tap</span>
          ) : captureRateIsNarrowband(sensors.snapshot.sampleRate) ? (
            <span className="text-[#b45309]">
              {`narrowband mic (${Math.round((sensors.snapshot.sampleRate ?? 0) / 1_000)}k) — unpair bluetooth headset`}
            </span>
          ) : cannotHearOwnChirps ? (
            <span className="text-[#b45309]">
              can&apos;t hear own chirps — raise volume, remove case
            </span>
          ) : null}
        </span>
      </header>

      <div
        className="absolute inset-x-0 top-0 bottom-0 overflow-y-auto px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(64px,calc(env(safe-area-inset-top)+44px))] transition-opacity duration-700"
        style={{ opacity: listening ? 1 : 0 }}
      >
        <div className="mx-auto flex max-w-xl flex-col gap-3">
          {devices.map((device) => {
            const self = device.deviceId === deviceId;
            return (
              <section
                className="rounded-2xl border border-black/8 bg-white shadow-[0_10px_34px_rgba(8,16,34,0.06)]"
                key={device.deviceId}
              >
                <div className="flex items-baseline justify-between px-4 pt-3 font-mono text-[10px] uppercase tracking-[0.14em]">
                  <span className="text-black/60">
                    {self ? "you" : `phone ${shortId(device.deviceId)}`}
                    {device.role === "host" ? (
                      <span className="text-[#007aff]"> · host</span>
                    ) : null}
                  </span>
                  <span className="text-black/40">
                    {self
                      ? describeDeviceSync(
                          syncByDevice.get(device.deviceId) ?? null,
                          device.role === "host",
                        )
                      : describePeerLink(
                          frameByDevice.get(device.deviceId) ?? null,
                          syncByDevice.get(device.deviceId) ?? null,
                          device.role === "host",
                          nowHostMs,
                        )}
                  </span>
                </div>
                <canvas
                  className="block h-[72px] w-full"
                  ref={registerCanvas(device.deviceId)}
                />
                {self ? (
                  <button
                    className="pointer-events-auto block w-full px-4 pb-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-black/30"
                    onClick={() => {
                      // A manual switch is an explicit choice: the automatic
                      // raw promotion must not override it moments later.
                      autoRawAttemptedRef.current = true;
                      sensors.requestCaptureMode(
                        nextCaptureMode(sensors.snapshot.captureMode),
                      );
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    type="button"
                  >
                    {captureDiagnostics(sensors.snapshot)} · tap to switch
                  </button>
                ) : null}
              </section>
            );
          })}
          {devices.length <= 1 ? (
            <p className="px-1 pt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-black/35">
              open this url on another phone
            </p>
          ) : (
            <>
              <ReconciliationPanel
                nowHostMs={nowHostMs}
                selfDeviceId={deviceId}
                state={reconciliation}
              />
              <RecordingPanel
                activeRecording={activeRecording}
                isHost={isHost}
                onToggle={toggleRecording}
                selfDeviceId={deviceId}
                statuses={recordingStatuses}
              />
            </>
          )}
        </div>
      </div>

      <div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 transition-opacity duration-1000"
        style={{ opacity: listening ? 0 : 1 }}
      >
        <h1
          className="text-[44px] leading-none tracking-tight text-[#06070a]"
          style={{
            animation: "arrival-rise 1.1s cubic-bezier(.2,.8,.2,1) both",
            fontFamily:
              "var(--font-display), Georgia, 'Times New Roman', serif",
            fontVariationSettings: "'opsz' 60, 'SOFT' 40, 'WONK' 1",
          }}
        >
          blackmagic
        </h1>
        <p
          className="font-mono text-[11px] uppercase tracking-[0.22em] text-black/40"
          style={{
            animation: "arrival-rise 1.1s cubic-bezier(.2,.8,.2,1) 220ms both",
          }}
        >
          tap anywhere — every phone becomes a waveform
        </p>
      </div>
    </main>
  );
}

function describeOwnSync(snapshot: SensorSnapshot) {
  const clock = snapshot.clock;
  if (!clock || !Number.isFinite(clock.maxErrorMs)) {
    return "tuning clock";
  }
  return `sync ±${Math.max(1, Math.round(clock.maxErrorMs))}ms`;
}

function describeDeviceSync(
  sync: DeviceTimeSyncState | null,
  isHost: boolean,
) {
  if (isHost) {
    return "clock";
  }
  if (!sync || sync.maxErrorMs === null) {
    return "syncing";
  }
  return `±${Math.max(1, Math.round(sync.maxErrorMs))}ms`;
}

// Link health for a peer row: the peer's own reported mic level (is its
// capture alive?) and how old its newest wave bucket is on this device's
// host-clock timeline (is the timeline aligned?). "Δ" far from ~1s or
// negative means the clocks disagree; "lvl 0" means the peer's mic is dead.
function describePeerLink(
  frame: RealtimeSensorFrameMessage | null,
  sync: DeviceTimeSyncState | null,
  isHost: boolean,
  nowHostMs: number | null,
) {
  const syncLabel = describeDeviceSync(sync, isHost);
  if (!frame) {
    return `${syncLabel} · no stream`;
  }

  const level =
    frame.micLevel > 0 ? frame.micLevel.toExponential(0) : "0";
  const ageMs =
    frame.wave && nowHostMs !== null
      ? Math.round(nowHostMs - frame.wave.endHostEpochMs)
      : null;
  const age = ageMs === null ? "" : ` · Δ${ageMs}ms`;
  // A narrowband capture route cannot see chirps at all — the single most
  // common silent reason a healthy-looking phone anchors no distances.
  const narrowband = captureRateIsNarrowband(frame.sampleRate)
    ? ` · ${Math.round((frame.sampleRate ?? 0) / 1_000)}k mic — no chirps`
    : "";
  return `${syncLabel} · lvl ${level}${age}${narrowband}`;
}

function shortId(deviceId: string) {
  return deviceId.slice(0, 4);
}

// The raw truth of the capture pipeline, on screen, so a silent waveform is
// diagnosable from the phone itself: context rate and state, which capture
// path is live, the actual RMS the analyser reads, recovery attempts, and
// whether iOS has the track muted.
function captureDiagnostics(snapshot: SensorSnapshot) {
  const rate = snapshot.sampleRate
    ? `${(snapshot.sampleRate / 1_000).toFixed(1)}k`
    : "—";
  const contextState = snapshot.audioContextState ?? "—";
  const processing = snapshot.captureProcessing
    ? snapshot.captureProcessing.rawCaptureVerified
      ? "raw"
      : snapshot.captureMode === "processed"
        ? "processed"
        : "filtered"
    : "—";
  const mode =
    snapshot.captureMode === "video" ? `video+${processing}` : processing;
  const level =
    snapshot.micLevel > 0 ? snapshot.micLevel.toExponential(1) : "0";
  const recoveries =
    snapshot.captureRecoveries > 0 ? ` · fix ${snapshot.captureRecoveries}` : "";
  const muted = snapshot.trackMuted ? " · muted" : "";
  return `${rate} ${contextState} · ${mode} · lvl ${level}${recoveries}${muted}`;
}

// Chrome/Firefox/Edge on iOS are WKWebView shells where getUserMedia and
// WebRTC support is limited and microphone capture is unreliable; only
// Safari runs the full WebKit media stack on iPhone.
function iosNonSafariBrowser(): string | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const ua = navigator.userAgent;
  if (!/iPhone|iPad|iPod/.test(ua)) {
    return null;
  }
  if (/CriOS/.test(ua)) {
    return "chrome";
  }
  if (/FxiOS/.test(ua)) {
    return "firefox";
  }
  if (/EdgiOS/.test(ua)) {
    return "edge";
  }
  return null;
}

// Cycle for the capture experiment: raw -> processed -> video-assisted.
function nextCaptureMode(
  mode: CaptureConstraintMode | null,
): CaptureConstraintMode {
  if (mode === "raw" || mode === null) {
    return "processed";
  }
  if (mode === "processed") {
    return "video";
  }
  return "raw";
}

// The host's engine snapshot, shaped for the wire. Broadcast even when
// ranges are empty so peers clear stale distances after a motion reset.
function reconciliationStateMessage(
  fromDeviceId: string,
  snapshot: ReconciliationSnapshot,
): RealtimeReconciliationStateMessage {
  return {
    type: "reconciliation-state",
    version: 1,
    fromDeviceId,
    updatedAtHostEpochMs: snapshot.updatedAtHostEpochMs,
    ranges: snapshot.ranges.map((range) => ({
      from: range.from,
      to: range.to,
      method: range.method,
      meters: range.meters,
      uncertaintyMeters: range.uncertaintyMeters,
      coverage: range.coverage,
      confidence: range.confidence,
      samplesUsed: range.samplesUsed,
    })),
    heardEvents: snapshot.heardEvents,
    pairProgress: snapshot.pairProgress,
    points: snapshot.layout?.points ?? null,
    layoutQuality: snapshot.layout?.quality ?? null,
    talker: snapshot.talker
      ? {
          x: snapshot.talker.x,
          y: snapshot.talker.y,
          residualMs: snapshot.talker.residualMs,
          confidence: snapshot.talker.confidence,
          atHostEpochMs: snapshot.talker.atHostEpochMs,
        }
      : null,
  };
}

const TALKER_FRESH_MS = 8_000;
const RECONCILIATION_STALE_MS = 12_000;

function ReconciliationPanel({
  state,
  selfDeviceId,
  nowHostMs,
}: {
  state: RealtimeReconciliationStateMessage | null;
  selfDeviceId: string;
  nowHostMs: number | null;
}) {
  const mapRef = useRef<HTMLCanvasElement | null>(null);
  const stale =
    state !== null &&
    nowHostMs !== null &&
    nowHostMs - state.updatedAtHostEpochMs > RECONCILIATION_STALE_MS;
  const talker =
    state?.talker &&
    nowHostMs !== null &&
    nowHostMs - state.talker.atHostEpochMs <= TALKER_FRESH_MS
      ? state.talker
      : null;
  const points =
    state?.points && Object.keys(state.points).length >= 2 ? state.points : null;

  useEffect(() => {
    const canvas = mapRef.current;
    if (canvas && points) {
      drawReconciliationMap(
        canvas,
        points,
        state?.ranges ?? [],
        talker,
        selfDeviceId,
        stale,
      );
    }
  }, [points, selfDeviceId, stale, state, talker]);

  const label = (id: string) => (id === selfDeviceId ? "you" : shortId(id));

  return (
    <section className="rounded-2xl border border-black/8 bg-white shadow-[0_10px_34px_rgba(8,16,34,0.06)]">
      <div className="flex items-baseline justify-between px-4 pt-3 font-mono text-[10px] uppercase tracking-[0.14em]">
        <span className="text-black/60">room</span>
        <span className="text-black/40">
          {stale
            ? "re-listening"
            : state && state.ranges.length > 0
              ? `${state.ranges.length} ${state.ranges.length === 1 ? "link" : "links"} ranged`
              : "listening"}
        </span>
      </div>
      {state && state.ranges.length > 0 ? (
        <div className="flex flex-col gap-1 px-4 pt-2 font-mono text-[11px] tracking-[0.05em]">
          {state.ranges.map((range) => (
            <div
              className="flex items-baseline justify-between"
              key={`${range.from}|${range.to}`}
              style={{ opacity: stale ? 0.4 : 1 }}
            >
              <span className="text-black/55">
                {label(range.from)} ↔ {label(range.to)}
              </span>
              <span className="text-black/80">
                {range.coverage < 0.5 ? "≥ " : ""}
                {range.meters.toFixed(2)} m
                <span className="text-black/35">
                  {" "}
                  ±{range.uncertaintyMeters.toFixed(2)} ·{" "}
                  {range.method === "chirp"
                    ? "chirp"
                    : describeRangeState(range.confidence, range.coverage)}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-black/35">
          {describeReconciliationProgress(state, label)}
        </p>
      )}
      {points ? (
        <canvas className="block h-[150px] w-full" ref={mapRef} />
      ) : (
        <div className="h-3" />
      )}
      <p className="px-4 pb-3 pt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-black/25">
        {talker
          ? "voice located · keep talking while moving to sharpen"
          : "walk and talk around the phones to sharpen the map"}
      </p>
    </section>
  );
}

// Pre-range progress line: show the deepest stage the pipeline has reached
// so a silent panel is diagnosable from the phone — are voice events being
// heard at all, and are they cross-matching between phones yet?
function describeReconciliationProgress(
  state: RealtimeReconciliationStateMessage | null,
  label: (id: string) => string,
) {
  const matching = (state?.pairProgress ?? []).filter(
    (pair) => pair.observations > 0,
  );
  if (matching.length > 0) {
    return matching
      .map(
        (pair) =>
          `${label(pair.from)} ↔ ${label(pair.to)} aligning ${Math.min(
            pair.observations,
            RANGE_TARGET_SAMPLES,
          )}/${RANGE_TARGET_SAMPLES}`,
      )
      .join(" · ");
  }

  const heard = (state?.heardEvents ?? []).filter((entry) => entry.events > 0);
  if (heard.length > 0) {
    return `voice marks · ${(state?.heardEvents ?? [])
      .map((entry) => `${label(entry.deviceId)} ${entry.events}`)
      .join(" · ")}`;
  }

  return "say something — distances appear as sound crosses the room";
}

// Ground-truth capture controls: the host starts/stops a synchronized
// recording; every phone shows its own capture/upload state, and the host
// additionally sees each device's reported status so a take is verifiably
// complete before the room moves.
function RecordingPanel({
  isHost,
  activeRecording,
  statuses,
  selfDeviceId,
  onToggle,
}: {
  isHost: boolean;
  activeRecording: { id: string; startedAtPerfMs: number } | null;
  statuses: Record<string, RealtimeRecordingStatusMessage>;
  selfDeviceId: string;
  onToggle: () => void;
}) {
  // Sampled via state so the elapsed readout ticks without impure reads
  // during render.
  const [nowPerfMs, setNowPerfMs] = useState(0);
  useEffect(() => {
    if (!activeRecording) {
      return;
    }
    // First tick lands after a second; until then the clamp below shows 0:00.
    const timer = window.setInterval(
      () => setNowPerfMs(performance.now()),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [activeRecording]);

  const entries = Object.values(statuses);
  if (!isHost && !activeRecording && entries.length === 0) {
    return null;
  }

  const elapsedSeconds = activeRecording
    ? Math.max(0, (nowPerfMs - activeRecording.startedAtPerfMs) / 1_000)
    : 0;
  const label = (id: string) => (id === selfDeviceId ? "you" : shortId(id));

  return (
    <section className="rounded-2xl border border-black/8 bg-white shadow-[0_10px_34px_rgba(8,16,34,0.06)]">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/60">
          capture
        </span>
        {isHost ? (
          <button
            className="pointer-events-auto flex items-center gap-2 rounded-full border border-black/10 px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em]"
            onClick={onToggle}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{
                background: activeRecording ? "#dc2626" : "#9ca3af",
              }}
            />
            {activeRecording
              ? `stop · ${formatElapsed(elapsedSeconds)}`
              : "record all phones"}
          </button>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/40">
            {activeRecording
              ? `recording · ${formatElapsed(elapsedSeconds)}`
              : "idle"}
          </span>
        )}
      </div>
      {entries.length > 0 ? (
        <div className="flex flex-col gap-1 px-4 pb-3 font-mono text-[10px] uppercase tracking-[0.12em]">
          {entries
            .sort((a, b) => a.fromDeviceId.localeCompare(b.fromDeviceId))
            .map((status) => (
              <div
                className="flex items-baseline justify-between"
                key={status.fromDeviceId}
              >
                <span className="text-black/50">{label(status.fromDeviceId)}</span>
                <span
                  className={
                    status.state === "failed"
                      ? "text-[#b45309]"
                      : status.state === "uploaded"
                        ? "text-[#047857]"
                        : "text-black/45"
                  }
                >
                  {status.state}
                  {status.detail ? ` · ${status.detail}` : ""}
                </span>
              </div>
            ))}
        </div>
      ) : (
        <div className="h-1" />
      )}
    </section>
  );
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function describeRangeState(confidence: number, coverage: number) {
  if (confidence >= 0.65 && coverage >= 0.5) {
    return "locked";
  }
  if (confidence >= 0.35) {
    return "settling";
  }
  return "gathering";
}

// Top-down room map: anchor-centered layout points, the talker as a warm
// pulse. The frame autoscales to the constellation with margin so phones
// stay visible however the room is laid out.
function drawReconciliationMap(
  canvas: HTMLCanvasElement,
  points: Record<string, { x: number; y: number }>,
  ranges: Array<{ from: string; to: string; meters: number }>,
  talker: { x: number; y: number; confidence: number } | null,
  selfDeviceId: string,
  stale: boolean,
) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const entries = Object.entries(points);
  const xs = entries.map(([, point]) => point.x);
  const ys = entries.map(([, point]) => point.y);
  if (talker) {
    xs.push(talker.x);
    ys.push(talker.y);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1.2);
  const spanY = Math.max(maxY - minY, 1.2);
  const margin = 26;
  const scale = Math.min(
    (width - margin * 2) / spanX,
    (height - margin * 2) / spanY,
  );
  const offsetX = (width - spanX * scale) / 2 - minX * scale;
  const offsetY = (height - spanY * scale) / 2 - minY * scale;
  const toCanvas = (point: { x: number; y: number }) => ({
    x: point.x * scale + offsetX,
    // Flip y so "up" on screen matches +y in the layout frame.
    y: height - (point.y * scale + offsetY),
  });

  const alpha = stale ? 0.35 : 1;

  // Faint range lines between every pair ground the dots visually; measured
  // pairs carry their live distance at the midpoint.
  context.strokeStyle = `rgba(6,17,46,${0.1 * alpha})`;
  context.lineWidth = 1;
  context.font = "9px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";
  context.textAlign = "center";
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = toCanvas(entries[i][1]);
      const b = toCanvas(entries[j][1]);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      const range = ranges.find(
        (entry) =>
          (entry.from === entries[i][0] && entry.to === entries[j][0]) ||
          (entry.from === entries[j][0] && entry.to === entries[i][0]),
      );
      if (range) {
        context.fillStyle = `rgba(5,6,10,${0.6 * alpha})`;
        context.fillText(
          `${range.meters.toFixed(2)} m · ${(range.meters / 0.3048).toFixed(1)} ft`,
          (a.x + b.x) / 2,
          (a.y + b.y) / 2 - 5,
        );
      }
    }
  }

  if (talker) {
    const spot = toCanvas(talker);
    const glow = context.createRadialGradient(
      spot.x,
      spot.y,
      0,
      spot.x,
      spot.y,
      16,
    );
    glow.addColorStop(0, `rgba(217,119,6,${0.5 * alpha})`);
    glow.addColorStop(1, "rgba(217,119,6,0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(spot.x, spot.y, 16, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = `rgba(180,83,9,${0.9 * alpha})`;
    context.beginPath();
    context.arc(spot.x, spot.y, 3.5, 0, Math.PI * 2);
    context.fill();
  }

  context.font =
    "9px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";
  context.textAlign = "center";
  for (const [id, point] of entries) {
    const spot = toCanvas(point);
    const self = id === selfDeviceId;
    context.fillStyle = self
      ? `rgba(0,122,255,${0.95 * alpha})`
      : `rgba(6,17,46,${0.8 * alpha})`;
    context.beginPath();
    context.arc(spot.x, spot.y, self ? 5 : 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = `rgba(5,6,10,${0.45 * alpha})`;
    context.fillText(
      self ? "you" : shortId(id),
      spot.x,
      spot.y - 9,
    );
  }
}

// Matched-filter fallback for chirps the streaming matcher missed: search
// the rolling audio window around the pulse's expected arrival, bounded by
// the clock uncertainty.
function maybeCreateMatchedObservation(
  pulse: AcousticPulse | null,
  snapshot: SensorSnapshot,
  observedPulseId: string,
) {
  if (
    !pulse ||
    pulse.id === observedPulseId ||
    !snapshot.audioFrame ||
    !snapshot.audioWindow
  ) {
    return null;
  }

  const sampleRate = snapshot.audioWindow.sampleRate;
  const clockUncertaintyMs =
    snapshot.clock?.uncertaintyMs ?? snapshot.audioFrame.clockUncertaintyMs;
  const earlyMs = Math.max(80, clockUncertaintyMs * 2);
  const lateMs = Math.max(180, clockUncertaintyMs * 3);
  const expectedStartSampleIndex =
    snapshot.audioFrame.sampleIndex +
    ((pulse.emittedAtHostEpochMs - snapshot.audioFrame.hostEstimatedEpochMs) /
      1_000) *
      snapshot.audioFrame.sampleRate;
  const searchStartSample = Math.max(
    0,
    Math.floor(
      expectedStartSampleIndex -
        snapshot.audioWindow.startSampleIndex -
        (earlyMs / 1_000) * sampleRate,
    ),
  );
  const searchEndSample = Math.min(
    snapshot.audioWindow.samples.length,
    Math.ceil(
      expectedStartSampleIndex -
        snapshot.audioWindow.startSampleIndex +
        ((lateMs + pulse.durationMs) / 1_000) * sampleRate,
    ),
  );

  // Two-stage search keeps this main-thread-cheap: a 4 ms-hop energy scan
  // finds the burst, then the full matched filter refines only ±25 ms
  // around it (the chirp dominates the window's energy at full gain).
  const samples = snapshot.audioWindow.samples;
  const hop = Math.max(32, Math.round(0.004 * sampleRate));
  let bestEnergy = -1;
  let bestAt = searchStartSample;
  for (let start = searchStartSample; start + hop <= searchEndSample; start += hop) {
    let energy = 0;
    for (let index = start; index < start + hop; index += 1) {
      energy += samples[index] * samples[index];
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestAt = start;
    }
  }
  const refineHalf = Math.round(0.025 * sampleRate);

  return createMatchedToneObservation({
    pulse,
    audioWindow: snapshot.audioWindow,
    searchStartSample: Math.max(searchStartSample, bestAt - refineHalf),
    searchEndSample: Math.min(searchEndSample, bestAt + hop + refineHalf),
    // Field-calibrated: real phone-to-phone chirps score 0.07-0.5 with peak
    // ratios of 6-50, while template-free windows (speech included) stay
    // below 0.01 score and ~6 ratio. The old 0.45 score gate rejected every
    // genuine reception in the ground-truth takes.
    minScore: 0.05,
    minPeakRatio: 4,
  });
}

// Play a scheduled chirp through the capture context: it was created inside
// the user's tap gesture, so iOS lets it produce sound. A context created
// here — outside any gesture — would stay suspended and the chirp would
// silently never play, so without a capture context the turn is skipped.
function scheduleOutputPulse(
  pulse: AcousticPulse,
  snapshot: SensorSnapshot,
  schedulerRef: { current: PulseToneScheduler | null },
  getCaptureContext: () => AudioContext | null,
) {
  const now = hostEpochNow(snapshot);
  if (now === null || !getCaptureContext()) {
    return;
  }
  schedulerRef.current ??= createPulseToneScheduler({
    createContext: () => {
      const captureContext = getCaptureContext();
      if (!captureContext) {
        throw new Error("capture context unavailable");
      }
      return captureContext;
    },
    ownsContext: false,
  });
  void schedulerRef.current
    .schedule(pulse, { hostEpochNowMs: now, peakGain: ULTRASONIC_CHIRP_GAIN })
    .catch(() => undefined);
}

function hostEpochNow(snapshot: SensorSnapshot) {
  if (snapshot.audioFrame) {
    return snapshot.audioFrame.hostEstimatedEpochMs;
  }
  if (!snapshot.clock || typeof performance === "undefined") {
    return null;
  }
  const nowPerfMs = performance.now();
  return (
    performance.timeOrigin +
    nowPerfMs +
    projectClockModel(snapshot.clock, nowPerfMs).offsetMs
  );
}

function drawWaveRow(
  canvas: HTMLCanvasElement,
  series: WaveSeries | null,
  endMs: number,
) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const mid = height / 2;
  context.strokeStyle = "rgba(5,6,10,0.08)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(8, mid);
  context.lineTo(width - 8, mid);
  context.stroke();

  if (!series) {
    return;
  }

  const levels = series.window(endMs, WAVE_WINDOW_MS, WAVE_RENDER_BUCKETS);
  const stale =
    series.latestMs() === null || endMs - (series.latestMs() ?? 0) > STALE_WAVE_MS;
  // Auto-gain against the recent peak so a quiet raw-capture mic still draws
  // a readable trace; the floor keeps silence from amplifying into noise.
  const peak = Math.max(series.recentPeak(endMs, WAVE_WINDOW_MS), 0.02);
  const usableWidth = width - 16;
  const step = usableWidth / WAVE_RENDER_BUCKETS;

  context.strokeStyle = stale ? "rgba(5,6,10,0.18)" : "rgba(6,17,46,0.78)";
  context.lineWidth = Math.max(1.2, step * 0.55);
  context.lineCap = "round";
  context.beginPath();
  for (let index = 0; index < levels.length; index += 1) {
    const x = 8 + index * step + step / 2;
    const magnitude = Math.min(1, levels[index] / peak);
    const half = Math.max(0.75, magnitude * (mid - 6));
    context.moveTo(x, mid - half);
    context.lineTo(x, mid + half);
  }
  context.stroke();
}
