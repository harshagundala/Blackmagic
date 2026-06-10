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
import { projectClockModel } from "@/lib/timing/clock-sync";
import { roomStatePollingIntervalMs } from "@/lib/session/polling";
import type {
  AcousticObservation,
  AcousticPulse,
  DeviceHeartbeat,
} from "@/lib/session/registry";
import { captureProcessingState } from "@/lib/session/registry";

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
  const snapshotRef = useRef(sensors.snapshot);
  const calibrationRef = useRef<CalibrationHeartbeat>({});
  const publishedPulseIdRef = useRef("");
  const observablePulseRef = useRef<AcousticPulse | null>(null);
  const publishedObservationRef = useRef<AcousticObservation | null>(null);
  const flushedCalibrationEventRef = useRef("");
  const flushedVoiceEventRef = useRef("");
  const pulseSchedulerRef = useRef<PulseToneScheduler | null>(null);
  const handleRealtimeChirp = useCallback(
    (pulse: AcousticPulse) => {
      observablePulseRef.current = pulse;
      trackSensorPulse(pulse);
    },
    [trackSensorPulse],
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
  });
  const constellation = useMemo(
    () =>
      roomState
        ? solveConstellationWithTemporalSeed(roomState, {
            perspectiveDeviceId: deviceId,
            headingDegrees: sensors.snapshot.headingDegrees,
          })
        : null,
    [deviceId, roomState, sensors.snapshot.headingDegrees],
  );

  useEffect(() => {
    snapshotRef.current = sensors.snapshot;
  }, [sensors.snapshot]);

  const begin = useCallback(async () => {
    if (phase === "listening") {
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

      const turn = roomState.calibrationTurn;
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
      scheduleOutputPulse(pulse, snapshotRef.current, pulseSchedulerRef);
    };

    void publishPulse();
    const timer = window.setInterval(() => void publishPulse(), 700);
    return () => {
      window.clearInterval(timer);
    };
  }, [deviceId, flushCalibrationEvent, phase, roomState, trackSensorPulse]);

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
  }, [deviceId, phase, roomState, sensors]);

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
    void flushCalibrationEvent(
      calibrationEventKey(
        "observation",
        acousticObservationPublishKey(observation),
      ),
    );
  }, [flushCalibrationEvent, phase, sensors.snapshot]);

  const listening = phase === "listening";
  const soundEnergy = roomSoundEnergy({
    localMicLevel: sensors.snapshot.micLevel,
    devices: roomState?.devices ?? [],
    audioSources: constellation?.audioSources ?? [],
  });
  const realtimePeerEnergy = realtime.peerFrames.reduce(
    (level, frame) => Math.max(level, frame.micLevel),
    0,
  );
  const fusedSoundEnergy = Math.max(soundEnergy, realtimePeerEnergy * 0.92);
  const pulse = listening
    ? Math.min(1, Math.max(0.12, fusedSoundEnergy))
    : 0.16;
  const phoneMarkers = createPhoneMarkers(
    constellation?.devices.filter((device) => device.deviceId !== deviceId) ??
      [],
  );
  const peerCount = Math.max(0, (roomState?.devices.length ?? 1) - 1);
  const syncLabel = describeTimeSync(roomState?.timeSync ?? null, peerCount);
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
          opacity: 0.78 + pulse * 0.18,
          transform: `translateY(${18 - pulse * 18}px) scaleY(${0.82 + pulse * 0.24})`,
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
            0.16 + pulse * 0.18
          }) 28%, rgba(0,0,0,${0.58 + pulse * 0.24}) 52%, rgba(0,86,255,${
            0.2 + pulse * 0.18
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
          opacity: 0.32 + pulse * 0.38,
        }}
      />

      <header
        className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between px-6 pt-[max(20px,env(safe-area-inset-top))] font-mono text-[10px] uppercase tracking-[0.14em] text-black/45 transition-opacity duration-700"
        style={{ opacity: listening ? 1 : 0 }}
      >
        <span className="flex items-center gap-2">
          {reconnecting
            ? "reconnecting"
            : peerCount === 0
              ? "alone so far"
              : `${peerCount} ${peerCount === 1 ? "phone" : "phones"} nearby`}
        </span>
        <span className="flex flex-col items-end gap-1 text-right">
          <span>{syncLabel}</span>
          {captureFiltered ? (
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
                      ? "block h-9 w-[18px] rounded-[6px] border border-[#007aff]/20 bg-white/80 shadow-[0_14px_30px_rgba(0,92,210,0.16)] backdrop-blur-md"
                      : "block h-9 w-[18px] rounded-[6px] border border-black/10 bg-white/76 shadow-[0_12px_28px_rgba(0,88,180,0.10)] backdrop-blur-md"
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
    minScore: 0.5,
    minPeakRatio: 2.2,
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
) {
  const now = hostEpochNow(snapshot);
  if (now === null) {
    return;
  }

  schedulerRef.current ??= createPulseToneScheduler({
    createContext: () => {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;
      return new AudioContextClass();
    },
  });
  void schedulerRef.current.schedule(pulse, { hostEpochNowMs: now });
}
