"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useRoomSession } from "@/hooks/use-room-session";
import { useSensorSuite, type SensorSnapshot } from "@/hooks/use-sensor-suite";
import { useWebRtcRoom } from "@/hooks/use-webrtc-room";
import { createPhoneMarkers } from "@/lib/blackmagic/phone-markers";
import { describeRangingProgress } from "@/lib/blackmagic/ranging-progress";
import { roomSoundEnergy } from "@/lib/blackmagic/room-sound-energy";
import {
  calibrationEventKey,
  hasPulseLead,
  shouldFlushCalibrationEvent,
} from "@/lib/calibration/cadence";
import {
  createMatchedToneObservation,
  createScheduledAcousticPulse,
} from "@/lib/calibration/pulse";
import {
  acousticObservationPublishKey,
  shouldPublishAcousticObservation,
} from "@/lib/calibration/observation-publishing";
import {
  createPulseToneScheduler,
  type PulseToneScheduler,
} from "@/lib/calibration/playback";
import { selectTrackedPulse } from "@/lib/calibration/session";
import type { PhonePoint } from "@/lib/positioning/layout";
import { estimateRoomConstellation } from "@/lib/positioning/room-state-layout";
import {
  createEdgeEvidence,
  deriveEdgeRanges,
  mergeAcousticRanges,
  recordEdgeObservation,
  recordEdgePulse,
} from "@/lib/realtime/edge-reconciliation";
import { projectClockModel } from "@/lib/timing/clock-sync";
import { roomStatePollingIntervalMs } from "@/lib/session/polling";
import type { AcousticRange } from "@/lib/session/ranging";
import type {
  AcousticObservation,
  AcousticPulse,
  DeviceHeartbeat,
} from "@/lib/session/registry";
import {
  captureProcessingState,
  selectRoomCalibrationTurn,
} from "@/lib/session/registry";

type Phase = "arriving" | "waiting" | "listening";

// A chirp is only advertised when peers have enough time to receive it through
// long-poll; after the server ack, WebAudio only needs a short scheduling lead.
const MIN_ADVERTISE_LEAD_MS = 1_500;
const MIN_OUTPUT_SCHEDULE_LEAD_MS = 120;
type CalibrationHeartbeat = Pick<
  DeviceHeartbeat,
  "acousticPulse" | "acousticObservation"
>;

export function BlackmagicApp() {
  const [phase, setPhase] = useState<Phase>("arriving");
  const { deviceId, heartbeat, roomState, connection } = useRoomSession({
    pollIntervalMs: roomStatePollingIntervalMs({
      listening: phase === "listening",
    }),
  });
  const sensors = useSensorSuite();
  const trackSensorPulse = sensors.trackPulse;
  const offerClockExchange = sensors.offerClockExchange;
  const setClockAuthority = sensors.setClockAuthority;
  const snapshotRef = useRef(sensors.snapshot);
  const calibrationRef = useRef<CalibrationHeartbeat>({});
  const publishedPulseIdRef = useRef("");
  const observablePulseRef = useRef<AcousticPulse | null>(null);
  const publishedObservationRef = useRef<AcousticObservation | null>(null);
  const flushedCalibrationEventRef = useRef("");
  const flushedVoiceEventRef = useRef("");
  const pulseSchedulerRef = useRef<PulseToneScheduler | null>(null);
  // Chirp evidence collected over the realtime channels; every device runs
  // the same reconciliation locally so ranges appear without waiting on the
  // server round trip. Derived ranges live in state so render never touches
  // the mutable evidence store.
  const edgeEvidenceRef = useRef(createEdgeEvidence());
  const [edgeView, setEdgeView] = useState<EdgeReconciliationView>({
    ranges: [],
    pulseCount: 0,
    observationCount: 0,
  });
  const refreshEdgeRanges = useCallback(() => {
    const evidence = edgeEvidenceRef.current;
    const next: EdgeReconciliationView = {
      ranges: deriveEdgeRanges(evidence, {
        hostEpochNowMs: hostEpochNow(snapshotRef.current),
      }),
      pulseCount: countEdgeItems(evidence.pulses),
      observationCount: countEdgeItems(evidence.observations),
    };
    // Keep the previous identity when nothing changed so the periodic
    // refresh does not re-solve the constellation for free.
    setEdgeView((current) =>
      current.pulseCount === next.pulseCount &&
      current.observationCount === next.observationCount &&
      acousticRangesEqual(current.ranges, next.ranges)
        ? current
        : next,
    );
  }, []);
  const recordPulseEvidence = useCallback(
    (deviceId: string, pulse: AcousticPulse | null | undefined) => {
      if (recordEdgePulse(edgeEvidenceRef.current, deviceId, pulse)) {
        refreshEdgeRanges();
      }
    },
    [refreshEdgeRanges],
  );
  const recordObservationEvidence = useCallback(
    (deviceId: string, observation: AcousticObservation | null | undefined) => {
      if (recordEdgeObservation(edgeEvidenceRef.current, deviceId, observation)) {
        refreshEdgeRanges();
      }
    },
    [refreshEdgeRanges],
  );
  const handleRealtimeChirp = useCallback(
    (pulse: AcousticPulse, fromDeviceId: string) => {
      recordPulseEvidence(fromDeviceId, pulse);
      // Only steal the single-pulse streaming matcher for chirps that are
      // actually still observable; a late-relayed schedule is evidence, not
      // something to listen for.
      const hostEpochNowMs = hostEpochNow(snapshotRef.current);
      if (hostEpochNowMs !== null) {
        const deltaMs = pulse.emittedAtHostEpochMs - hostEpochNowMs;
        if (deltaMs > 5_500 || deltaMs < -180) {
          return;
        }
      }
      observablePulseRef.current = pulse;
      trackSensorPulse(pulse);
    },
    [recordPulseEvidence, trackSensorPulse],
  );
  const handleRealtimeObservation = useCallback(
    (observation: AcousticObservation, fromDeviceId: string) => {
      recordObservationEvidence(fromDeviceId, observation);
    },
    [recordObservationEvidence],
  );
  const getRealtimePulse = useCallback(
    () =>
      observablePulseRef.current ?? calibrationRef.current.acousticPulse ?? null,
    [],
  );
  const getRealtimeObservation = useCallback(
    () =>
      calibrationRef.current.acousticObservation ??
      snapshotRef.current.pulseObservation,
    [],
  );
  const realtime = useWebRtcRoom({
    active: phase === "listening",
    deviceId,
    roomState,
    snapshot: sensors.snapshot,
    getAcousticPulse: getRealtimePulse,
    getAcousticObservation: getRealtimeObservation,
    onChirpSchedule: handleRealtimeChirp,
    onPulseObservation: handleRealtimeObservation,
    onClockExchange: offerClockExchange,
  });
  const mergedRanges = useMemo(() => {
    if (!roomState) {
      return [] as AcousticRange[];
    }
    return edgeView.ranges.length > 0
      ? mergeAcousticRanges(roomState.ranges, edgeView.ranges)
      : roomState.ranges;
  }, [edgeView.ranges, roomState]);
  const constellation = useMemo(() => {
    if (!roomState) {
      return null;
    }

    return solveConstellationWithTemporalSeed(
      mergedRanges === roomState.ranges
        ? roomState
        : { ...roomState, ranges: mergedRanges },
      {
        perspectiveDeviceId: deviceId,
        headingDegrees: sensors.snapshot.headingDegrees,
      },
    );
  }, [deviceId, mergedRanges, roomState, sensors.snapshot.headingDegrees]);

  useEffect(() => {
    snapshotRef.current = sensors.snapshot;
  }, [sensors.snapshot]);

  // Re-derive edge ranges on a slow cadence so measurements age out of the
  // constellation even when no fresh chirp evidence is arriving.
  useEffect(() => {
    if (phase !== "listening") {
      return;
    }
    const timer = window.setInterval(refreshEdgeRanges, 3_000);
    return () => window.clearInterval(timer);
  }, [phase, refreshEdgeRanges]);

  // The first connected device is the host and its clock is the room
  // reference: peers NTP-sync against it over the data channel, the host
  // publishes its own clock verbatim.
  useEffect(() => {
    if (!roomState?.hostDeviceId) {
      return;
    }
    setClockAuthority(
      roomState.hostDeviceId === deviceId ? "self" : "external",
    );
  }, [deviceId, roomState?.hostDeviceId, setClockAuthority]);

  const begin = useCallback(async () => {
    if (phase === "listening") {
      // A tap is a fresh user gesture: if the mic never started (prompt was
      // dismissed, or iOS dropped the request), retry the whole capture
      // pipeline now while the activation is valid.
      if (snapshotRef.current.mic === "blocked") {
        await sensors.start();
      }
      return;
    }

    setPhase("listening");
    await sensors.start();
  }, [phase, sensors]);

  const flushCalibrationEvent = useCallback(
    async (eventKey: string) => {
      if (
        !shouldFlushCalibrationEvent(
          flushedCalibrationEventRef.current,
          eventKey,
        )
      ) {
        return false;
      }

      flushedCalibrationEventRef.current = eventKey;
      return heartbeat(snapshotRef.current, calibrationRef.current);
    },
    [heartbeat],
  );

  useEffect(() => {
    if (phase !== "listening") {
      return;
    }

    void heartbeat(snapshotRef.current, calibrationRef.current);
    const timer = window.setInterval(
      () => void heartbeat(snapshotRef.current, calibrationRef.current),
      1_500,
    );
    return () => window.clearInterval(timer);
  }, [heartbeat, phase]);

  useEffect(() => {
    if (phase !== "listening" || !roomState) {
      return;
    }

    const publishPulse = async () => {
      const hostEpochNowMs = hostEpochNow(snapshotRef.current);
      if (hostEpochNowMs === null) {
        return;
      }

      // The turn rotation is derived client-side from the shared host-domain
      // clock: every device computes the same schedule without depending on
      // the server's wall clock, which lives in a different time domain.
      const turn = selectRoomCalibrationTurn(roomState.devices, hostEpochNowMs);
      if (!turn || turn.emitterId !== deviceId) {
        return;
      }

      const pulse = createScheduledAcousticPulse({
        deviceId,
        sequence: turn.sequence,
        hostEpochNowMs,
        leadMs: turn.pulseEmittedAtHostEpochMs - hostEpochNowMs,
        durationMs: turn.pulseDurationMs,
      });
      if (!hasPulseLead(pulse, hostEpochNowMs, MIN_ADVERTISE_LEAD_MS)) {
        return;
      }
      if (pulse.id === publishedPulseIdRef.current) {
        return;
      }

      publishedPulseIdRef.current = pulse.id;
      calibrationRef.current = {
        acousticPulse: pulse,
        acousticObservation: calibrationRef.current.acousticObservation ?? null,
      };
      // Advertise first and only chirp once the server acknowledged the
      // advertisement with enough lead for peers to poll it. An unannounced
      // chirp wastes the slot: nobody is listening for it.
      const acknowledged = await flushCalibrationEvent(
        calibrationEventKey("pulse", pulse.id),
      );
      if (!acknowledged) {
        // The advertisement never landed; allow the interval to retry while
        // there is still lead instead of burning the slot silently.
        publishedPulseIdRef.current = "";
        flushedCalibrationEventRef.current = "";
        return;
      }
      if (
        !hasPulseLead(
          pulse,
          hostEpochNow(snapshotRef.current) ?? Number.NaN,
          MIN_OUTPUT_SCHEDULE_LEAD_MS,
        )
      ) {
        publishedPulseIdRef.current = "";
        flushedCalibrationEventRef.current = "";
        calibrationRef.current = {
          acousticPulse: null,
          acousticObservation:
            calibrationRef.current.acousticObservation ?? null,
        };
        return;
      }
      observablePulseRef.current = pulse;
      trackSensorPulse(pulse);
      recordPulseEvidence(deviceId, pulse);
      scheduleOutputPulse(
        pulse,
        snapshotRef.current,
        pulseSchedulerRef,
        sensors.getAudioContext,
      );
    };

    void publishPulse();
    const timer = window.setInterval(() => void publishPulse(), 700);
    return () => {
      window.clearInterval(timer);
    };
  }, [
    deviceId,
    flushCalibrationEvent,
    phase,
    recordPulseEvidence,
    roomState,
    sensors.getAudioContext,
    trackSensorPulse,
  ]);

  useEffect(
    () => () => {
      void pulseSchedulerRef.current?.close();
      pulseSchedulerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (phase !== "listening" || !roomState) {
      observablePulseRef.current = null;
      sensors.trackPulse(null);
      return;
    }

    const hostEpochNowMs = hostEpochNow(sensors.snapshot);
    const pulse =
      hostEpochNowMs === null
        ? null
        : selectTrackedPulse(
            roomState.devices,
            deviceId,
            hostEpochNowMs,
            observablePulseRef.current,
          );

    if (observablePulseRef.current?.id === pulse?.id) {
      return;
    }

    observablePulseRef.current = pulse;
    sensors.trackPulse(pulse);
    if (pulse) {
      recordPulseEvidence(pulseEmitterId(pulse), pulse);
    }
  }, [deviceId, phase, recordPulseEvidence, roomState, sensors]);

  useEffect(() => {
    const voiceEventId = sensors.snapshot.voiceEvent?.id;
    if (
      phase !== "listening" ||
      !voiceEventId ||
      voiceEventId === flushedVoiceEventRef.current
    ) {
      return;
    }

    flushedVoiceEventRef.current = voiceEventId;
    void heartbeat(snapshotRef.current, calibrationRef.current);
  }, [heartbeat, phase, sensors.snapshot.voiceEvent?.id]);

  useEffect(() => {
    const pulse = observablePulseRef.current;
    if (phase !== "listening" || !pulse) {
      return;
    }

    const observation =
      sensors.snapshot.pulseObservation?.pulseId === pulse.id
        ? sensors.snapshot.pulseObservation
        : maybeCreateObservation(
            pulse,
            sensors.snapshot,
            publishedObservationRef.current?.pulseId ?? "",
          );

    if (!observation) {
      return;
    }

    if (
      !shouldPublishAcousticObservation(
        publishedObservationRef.current,
        observation,
      )
    ) {
      return;
    }

    publishedObservationRef.current = observation;
    calibrationRef.current = {
      acousticPulse: calibrationRef.current.acousticPulse ?? null,
      acousticObservation: observation,
    };
    recordObservationEvidence(deviceId, observation);
    void flushCalibrationEvent(
      calibrationEventKey(
        "observation",
        acousticObservationPublishKey(observation),
      ),
    );
  }, [
    deviceId,
    flushCalibrationEvent,
    phase,
    recordObservationEvidence,
    sensors.snapshot,
  ]);

  const listening = phase === "listening";
  // Realtime peer frames go through the same saturating microphone curve as
  // every other level: raw RMS speech sits around 0.02, which reads as ~2%
  // energy if it skips the curve — invisible on the gradient.
  const soundEnergy = roomSoundEnergy({
    localMicLevel: sensors.snapshot.micLevel,
    devices: [
      ...(roomState?.devices ?? []),
      ...realtime.peerFrames.map((frame) => ({ micLevel: frame.micLevel })),
    ],
    audioSources: constellation?.audioSources ?? [],
  });
  const pulse = listening ? Math.min(1, Math.max(0.12, soundEnergy)) : 0.16;
  const phoneMarkers = createPhoneMarkers(
    constellation?.devices.filter((device) => device.deviceId !== deviceId) ??
      [],
  );
  const peerCount = Math.max(0, (roomState?.devices.length ?? 1) - 1);
  const syncLabel = describeTimeSync(roomState?.timeSync ?? null, peerCount);
  const serverPulseCount =
    roomState?.devices.reduce(
      (count, device) =>
        count + (device.acousticPulses?.length ?? (device.acousticPulse ? 1 : 0)),
      0,
    ) ?? 0;
  const serverObservationCount =
    roomState?.devices.reduce(
      (count, device) =>
        count +
        (device.acousticObservations?.length ??
          (device.acousticObservation ? 1 : 0)),
      0,
    ) ?? 0;
  const rangingLabel = listening
    ? describeRangingProgress({
        peerCount,
        pulseCount: Math.max(edgeView.pulseCount, serverPulseCount),
        observationCount: Math.max(
          edgeView.observationCount,
          serverObservationCount,
        ),
        ranges: mergedRanges,
        emitterReadyCount:
          roomState?.devices.filter(
            (device) => device.mic === "active" && device.audioFrame,
          ).length ?? 0,
        deviceCount: roomState?.devices.length ?? 0,
        directLinkOpen: realtime.openPeerCount > 0,
      })
    : null;
  const captureStatus = captureProcessingState(
    sensors.snapshot.captureProcessing,
  );
  const captureFiltered = captureStatus === "filtered";
  const reconnecting = connection === "reconnecting";

  return (
    <main
      aria-label="Blackmagic session"
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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[44dvh] blur-2xl will-change-transform"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(0,122,255,0.13) 36%, rgba(0,61,160,0.43) 66%, rgba(2,4,9,0.96) 100%)",
          opacity: 0.6 + pulse * 0.4,
          transform: `translateY(${24 - pulse * 28}px) scaleY(${0.76 + pulse * 0.38})`,
          transformOrigin: "bottom",
          transition:
            "opacity 160ms linear, transform 180ms cubic-bezier(.2,.8,.2,1)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-[-34%] bottom-[-6dvh] h-[28dvh] blur-3xl"
        style={{
          animation: "bottom-current 7.5s ease-in-out infinite",
          background: `linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(0,122,255,${
            0.12 + pulse * 0.34
          }) 28%, rgba(0,0,0,${0.5 + pulse * 0.36}) 52%, rgba(0,86,255,${
            0.16 + pulse * 0.34
          }) 76%, rgba(255,255,255,0) 100%)`,
          transformOrigin: "bottom",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[18dvh]"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(0,0,0,0.2) 72%, rgba(0,0,0,0.82) 100%)",
          opacity: 0.24 + pulse * 0.56,
        }}
      />

      <header
        className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between px-6 pt-[max(20px,env(safe-area-inset-top))] font-mono text-[10px] uppercase tracking-[0.14em] text-black/45 transition-opacity duration-700"
        style={{ opacity: listening ? 1 : 0 }}
      >
        <span className="flex flex-col gap-1">
          <span>
            {reconnecting
              ? "reconnecting"
              : peerCount === 0
                ? "alone so far"
                : `${peerCount} ${peerCount === 1 ? "phone" : "phones"} nearby`}
          </span>
          {rangingLabel ? (
            <span className="text-black/35">{rangingLabel}</span>
          ) : null}
        </span>
        <span className="flex flex-col items-end gap-1 text-right">
          <span>{syncLabel}</span>
          {sensors.snapshot.mic === "blocked" ? (
            <span className="text-[#b45309]">mic off — tap to enable</span>
          ) : sensors.snapshot.audioContextState &&
            sensors.snapshot.audioContextState !== "running" ? (
            <span className="text-[#b45309]">audio paused — tap</span>
          ) : captureFiltered ? (
            <span className="text-[#b45309]">filtered mic</span>
          ) : null}
        </span>
      </header>

      <div className="absolute inset-0 overflow-hidden px-8 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(28px,env(safe-area-inset-top))]">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[43dvh] h-px w-px"
        >
          {phoneMarkers.slice(0, 9).map((marker) => (
            <span
              aria-hidden
              className="absolute left-0 top-0 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center will-change-transform"
              key={marker.id}
              style={{
                opacity: marker.opacity,
                transform: `translate(${marker.xPx}px, ${marker.yPx}px) scale(${marker.scale})`,
                transition:
                  "opacity 280ms ease, transform 760ms cubic-bezier(.2,.8,.2,1)",
              }}
            >
              <span
                className={
                  marker.localized
                    ? "block h-10 w-5 rounded-[6px] border border-black/15 bg-[linear-gradient(180deg,#06070a_0%,#061935_48%,#007aff_100%)] shadow-[0_18px_38px_rgba(0,77,190,0.24)]"
                    : marker.coarse
                      ? "block h-9 w-[18px] rounded-[6px] border-2 border-[#007aff]/55 bg-white/90 shadow-[0_14px_30px_rgba(0,92,210,0.22)] backdrop-blur-md"
                      : "block h-9 w-[18px] rounded-[6px] border border-black/30 bg-white/85 shadow-[0_12px_28px_rgba(0,88,180,0.14)] backdrop-blur-md"
                }
                style={{
                  transform: `rotate(${marker.rotationDeg}deg)`,
                }}
              />
              {marker.distanceLabel ? (
                <span className="mt-1 font-mono text-[10px] font-medium leading-none tracking-normal text-black/54">
                  {marker.distanceLabel}
                </span>
              ) : null}
            </span>
          ))}
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
          tap anywhere — the room starts listening
        </p>
      </div>
    </main>
  );
}

function describeTimeSync(
  timeSync:
    | NonNullable<Parameters<typeof estimateRoomConstellation>[0]>["timeSync"]
    | null,
  peerCount: number,
) {
  if (!timeSync || peerCount === 0) {
    return "open this url on another phone";
  }

  switch (timeSync.status) {
    case "ready":
      return timeSync.worstLocalizationErrorMs !== null
        ? `sync ±${Math.max(1, Math.round(timeSync.worstLocalizationErrorMs))}ms`
        : "sync ready";
    case "warming":
      return "tuning clocks";
    case "degraded":
      return "coarse sync";
    default:
      return "waiting for phones";
  }
}

// Memo cache feeding each solve the previous frame's canonical layout so the
// constellation stays rotation/reflection-stable over time. Keyed by the
// viewing device; the alignment is idempotent, so a repeated render with the
// same room state is harmless.
const temporalLayoutSeeds = new Map<string, Record<string, PhonePoint>>();

function solveConstellationWithTemporalSeed(
  roomState: NonNullable<Parameters<typeof estimateRoomConstellation>[0]>,
  options: {
    perspectiveDeviceId: string;
    headingDegrees: number | null;
  },
) {
  const constellation = estimateRoomConstellation(roomState, {
    ...options,
    previousCanonicalPoints:
      temporalLayoutSeeds.get(options.perspectiveDeviceId) ?? null,
  });
  temporalLayoutSeeds.set(
    options.perspectiveDeviceId,
    constellation.canonicalPoints,
  );
  return constellation;
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

function maybeCreateObservation(
  pulse: AcousticPulse | null,
  snapshot: SensorSnapshot,
  observedPulseId: string,
): AcousticObservation | null {
  if (!pulse || pulse.id === observedPulseId || !snapshot.audioFrame) {
    return null;
  }

  if (!snapshot.audioWindow) {
    return null;
  }

  return createMatchedToneObservation({
    pulse,
    audioWindow: snapshot.audioWindow,
    ...pulseSearchBounds(pulse, snapshot),
    minScore: 0.45,
    minPeakRatio: 2,
  });
}

function pulseSearchBounds(pulse: AcousticPulse, snapshot: SensorSnapshot) {
  if (!snapshot.audioFrame || !snapshot.audioWindow) {
    return {};
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

  return {
    searchStartSample: Math.max(
      0,
      Math.floor(
        expectedStartSampleIndex -
          snapshot.audioWindow.startSampleIndex -
          (earlyMs / 1_000) * sampleRate,
      ),
    ),
    searchEndSample: Math.ceil(
      expectedStartSampleIndex -
        snapshot.audioWindow.startSampleIndex +
        (lateMs / 1_000) * sampleRate,
    ),
  };
}

function scheduleOutputPulse(
  pulse: AcousticPulse,
  snapshot: SensorSnapshot,
  schedulerRef: MutableRefObject<PulseToneScheduler | null>,
  getCaptureContext: () => AudioContext | null,
) {
  const now = hostEpochNow(snapshot);
  if (now === null) {
    return;
  }

  // Play through the capture context: it was created inside the user's tap
  // gesture, so iOS lets it produce sound. A context created here — outside
  // any gesture — would stay suspended and the chirp would silently never
  // play, so without a capture context the turn is skipped instead.
  if (!getCaptureContext()) {
    return;
  }
  schedulerRef.current ??= createPulseToneScheduler({
    createContext: () => {
      // Resolved per schedule via the closed-context check, so a recreated
      // capture context is picked up automatically.
      const captureContext = getCaptureContext();
      if (!captureContext) {
        throw new Error("capture context unavailable");
      }
      return captureContext;
    },
    ownsContext: false,
  });
  void schedulerRef.current
    .schedule(pulse, { hostEpochNowMs: now })
    .catch(() => undefined);
}

type EdgeReconciliationView = {
  ranges: AcousticRange[];
  pulseCount: number;
  observationCount: number;
};

function countEdgeItems(store: Map<string, unknown[]>) {
  let count = 0;
  for (const items of store.values()) {
    count += items.length;
  }
  return count;
}

function acousticRangesEqual(left: AcousticRange[], right: AcousticRange[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((range, index) => {
    const other = right[index];
    return (
      range.from === other.from &&
      range.to === other.to &&
      range.pulseId === other.pulseId &&
      range.meters === other.meters &&
      range.samplesUsed === other.samplesUsed &&
      range.confidence === other.confidence &&
      range.observedAtHostEpochMs === other.observedAtHostEpochMs
    );
  });
}

function pulseEmitterId(pulse: AcousticPulse) {
  // Pulse ids are `${deviceId}:${sequence}:${epochMs}`; device ids are UUIDs
  // and never contain colons.
  return pulse.id.split(":")[0] ?? "";
}
