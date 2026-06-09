"use client";

import {
  useCallback,
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useRoomSession } from "@/hooks/use-room-session";
import { useSensorSuite, type SensorSnapshot } from "@/hooks/use-sensor-suite";
import {
  calibrationEventKey,
  shouldFlushCalibrationEvent,
} from "@/lib/calibration/cadence";
import {
  createMatchedToneObservation,
  createScheduledAcousticPulse,
} from "@/lib/calibration/pulse";
import {
  createPulseToneScheduler,
  type PulseToneScheduler,
} from "@/lib/calibration/playback";
import {
  selectObservablePulse,
} from "@/lib/calibration/session";
import { estimateRoomConstellation } from "@/lib/positioning/room-state-layout";
import { roomStatePollingIntervalMs } from "@/lib/session/polling";
import type {
  AcousticObservation,
  AcousticPulse,
  DeviceHeartbeat,
} from "@/lib/session/registry";

type Phase = "arriving" | "waiting" | "listening";
type CalibrationHeartbeat = Pick<
  DeviceHeartbeat,
  "acousticPulse" | "acousticObservation"
>;

export function BlackmagicApp() {
  const [phase, setPhase] = useState<Phase>("arriving");
  const { deviceId, heartbeat, roomState } = useRoomSession({
    pollIntervalMs: roomStatePollingIntervalMs({
      listening: phase === "listening",
    }),
  });
  const sensors = useSensorSuite();
  const snapshotRef = useRef(sensors.snapshot);
  const calibrationRef = useRef<CalibrationHeartbeat>({});
  const publishedPulseIdRef = useRef("");
  const observablePulseRef = useRef<AcousticPulse | null>(null);
  const observedPulseIdRef = useRef("");
  const flushedCalibrationEventRef = useRef("");
  const pulseSchedulerRef = useRef<PulseToneScheduler | null>(null);
  const peerCount =
    roomState?.devices.filter((device) => device.deviceId !== deviceId).length ?? 0;
  const constellation = useMemo(
    () =>
      roomState
        ? estimateRoomConstellation(roomState, {
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
    (eventKey: string) => {
      if (
        !shouldFlushCalibrationEvent(
          flushedCalibrationEventRef.current,
          eventKey,
        )
      ) {
        return;
      }

      flushedCalibrationEventRef.current = eventKey;
      void heartbeat(snapshotRef.current, calibrationRef.current);
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

    const publishPulse = () => {
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
        audioFrame: snapshotRef.current.audioFrame,
        leadMs: turn.pulseEmittedAtHostEpochMs - hostEpochNowMs,
        durationMs: turn.pulseDurationMs,
      });
      if (pulse.id === publishedPulseIdRef.current) {
        return;
      }

      publishedPulseIdRef.current = pulse.id;
      calibrationRef.current = {
        acousticPulse: pulse,
        acousticObservation: calibrationRef.current.acousticObservation ?? null,
      };
      scheduleOutputPulse(pulse, snapshotRef.current, pulseSchedulerRef);
      flushCalibrationEvent(calibrationEventKey("pulse", pulse.id));
    };

    publishPulse();
    const timer = window.setInterval(publishPulse, 700);
    return () => {
      window.clearInterval(timer);
    };
  }, [deviceId, flushCalibrationEvent, phase, roomState]);

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
        : selectObservablePulse(roomState.devices, deviceId, hostEpochNowMs);

    if (observablePulseRef.current?.id === pulse?.id) {
      return;
    }

    observablePulseRef.current = pulse;
    sensors.trackPulse(pulse);
  }, [deviceId, phase, roomState, sensors]);

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
            observedPulseIdRef.current,
          );

    if (!observation || observation.pulseId === observedPulseIdRef.current) {
      return;
    }

    observedPulseIdRef.current = observation.pulseId;
    calibrationRef.current = {
      acousticPulse: calibrationRef.current.acousticPulse ?? null,
      acousticObservation: observation,
    };
    flushCalibrationEvent(
      calibrationEventKey("observation", observation.pulseId),
    );
  }, [flushCalibrationEvent, phase, sensors.snapshot]);

  const pulse = phase === "listening" ? Math.min(1, Math.max(0.18, sensors.snapshot.micLevel * 24)) : 0.28;
  const constellationDots =
    constellation?.devices.filter(
      (device) => device.deviceId !== deviceId,
    ) ?? [];
  const sourceHints =
    constellation?.audioSources
      .filter((source) => source.ageMs <= 6_000)
      .slice(-3) ?? [];

  return (
    <main
      aria-label="Blackmagic session"
      className="relative min-h-dvh cursor-default overflow-hidden bg-[#f7f9fc] text-[#05060a]"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          void begin();
        }
      }}
      onPointerDown={() => void begin()}
      role="button"
      tabIndex={0}
    >
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#ffffff_0%,#eef7ff_58%,#fbfdff_100%)]" />
      <div className="absolute inset-0 opacity-80 [background:radial-gradient(120%_84%_at_50%_-16%,rgba(255,255,255,0.98)_0%,rgba(255,255,255,0.52)_34%,rgba(129,202,255,0.20)_58%,rgba(255,255,255,0)_82%)]" />
      <div className="absolute inset-x-[-20%] top-[18dvh] h-[58dvh] blur-3xl [background:linear-gradient(105deg,rgba(255,255,255,0)_0%,rgba(161,213,255,0.34)_32%,rgba(255,255,255,0.66)_52%,rgba(190,225,255,0.24)_70%,rgba(255,255,255,0)_100%)]" />
      <div className="absolute inset-x-[-35%] bottom-[-18dvh] h-[46dvh] blur-3xl [background:linear-gradient(90deg,rgba(0,122,255,0)_0%,rgba(0,122,255,0.16)_42%,rgba(255,255,255,0.78)_56%,rgba(0,122,255,0.12)_76%,rgba(0,122,255,0)_100%)]" />

      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute left-1/2 top-1/2 h-[68dvh] max-h-[720px] min-h-[420px] w-[68dvh] min-w-[420px] max-w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-[45%] border border-white/55 bg-white/14 shadow-[inset_0_0_90px_rgba(255,255,255,0.82),0_40px_160px_rgba(56,146,255,0.18)] backdrop-blur-3xl"
          style={{
            animation: "liquid-field 7s ease-in-out infinite",
            opacity: 0.86 + pulse * 0.08,
          }}
        />
        <div
          className="absolute left-1/2 top-1/2 h-[44dvh] max-h-[520px] min-h-[280px] w-[44dvh] min-w-[280px] max-w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-[42%] border border-white/65 bg-white/22 shadow-[inset_0_1px_30px_rgba(255,255,255,0.88),0_20px_90px_rgba(0,122,255,0.12)] backdrop-blur-2xl"
          style={{
            animation: "liquid-drift 9s ease-in-out infinite",
            transform: `translate(-50%, -50%) scale(${0.96 + pulse * 0.06})`,
          }}
        />
        {(constellationDots.length > 0
          ? constellationDots.slice(0, 7)
          : Array.from({ length: Math.min(peerCount, 5) }).map((_, index) => ({
              confidence: 0.28 + index * 0.08,
              deviceId: `fallback-${index}`,
              x: Math.cos(index * 1.78 - 1.1) * 1.65,
              y: Math.sin(index * 1.78 - 1.1) * 1.65,
            }))
        ).map((device, index) => {
          const x = clamp(device.x * 84, -190, 190);
          const y = clamp(device.y * 84, -190, 190);
          const confidence = clamp(device.confidence, 0.2, 1);

          return (
            <span
              aria-hidden
              className="absolute left-1/2 top-1/2 h-3 w-3 rounded-full bg-[#05060a]/55 shadow-[0_0_28px_rgba(0,122,255,0.26)]"
              key={device.deviceId}
              style={{
                transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${0.82 + confidence * 0.36})`,
                opacity: 0.28 + confidence * 0.42 + index * 0.025,
                transition: "transform 700ms cubic-bezier(.2,.8,.2,1), opacity 300ms ease",
              }}
            />
          );
        })}
        {sourceHints.map((source, index) => {
          const x = clamp(source.x * 84, -210, 210);
          const y = clamp(source.y * 84, -210, 210);
          const freshness = 1 - clamp(source.ageMs / 6_000, 0, 1);
          const strength = clamp(source.confidence, 0.18, 1) * freshness;

          const transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;

          return (
            <Fragment key={source.eventId}>
              <span
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-28 w-28 rounded-[44%] bg-[#007aff]/24 blur-xl"
                style={{
                  animation: "source-bloom 1.9s ease-out infinite",
                  animationDelay: `${index * 120}ms`,
                  opacity: 0.18 + strength * 0.58,
                  transform: `${transform} scale(${0.5 + strength * 0.86})`,
                  transition: "transform 700ms cubic-bezier(.2,.8,.2,1), opacity 260ms ease",
                }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 z-30 h-4 w-4 rounded-full bg-[#007aff]/45 blur-[1px] shadow-[0_0_34px_rgba(0,122,255,0.48)]"
                style={{
                  opacity: 0.16 + strength * 0.62,
                  transform: `${transform} scale(${0.82 + strength * 0.7})`,
                  transition: "transform 700ms cubic-bezier(.2,.8,.2,1), opacity 260ms ease",
                }}
              />
            </Fragment>
          );
        })}
      </div>

      <section className="relative z-10 flex min-h-dvh flex-col items-center justify-between px-8 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(34px,env(safe-area-inset-top))] text-center">
        <div className="h-20" />

        <div className="flex flex-col items-center">
          <div className="relative grid h-36 w-36 place-items-center sm:h-44 sm:w-44">
            <span className="absolute inset-0 rounded-[42%] bg-white/20 shadow-[inset_0_0_28px_rgba(255,255,255,0.92),0_22px_80px_rgba(16,98,180,0.20)] backdrop-blur-2xl" />
            <span
              className="absolute h-24 w-24 rounded-[44%] border border-white/70 bg-white/26 shadow-[inset_0_0_18px_rgba(255,255,255,0.95),0_10px_60px_rgba(0,122,255,0.18)]"
              style={{
                animation: "liquid-pulse 4.8s ease-in-out infinite reverse",
                transform: `scale(${0.82 + pulse * 0.26})`,
              }}
            />
            <span className="relative h-5 w-5 rounded-full bg-[#05060a] shadow-[0_0_34px_rgba(0,0,0,0.28)]" />
          </div>

          <p className="mt-8 min-h-5 font-mono text-[11px] uppercase tracking-[0.42em] text-black/40">
          </p>
        </div>

        <div className="flex flex-col items-center gap-4">
          <div className="h-10">
            {phase === "listening" ? (
              <div className="flex h-10 items-center gap-1.5" aria-hidden>
                {Array.from({ length: 7 }).map((_, index) => (
                  <span
                    className="w-1 rounded-full bg-[#007aff]/55"
                    key={index}
                    style={{
                      height: `${8 + Math.sin(index + pulse * 7) * 5 + pulse * 28}px`,
                      transition: "height 160ms ease",
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <p className="max-w-56 text-[12px] font-medium leading-5 tracking-[0.04em] text-black/28">
            {phase === "listening" ? "listening" : ""}
          </p>
        </div>
      </section>
    </main>
  );
}

function hostEpochNow(snapshot: SensorSnapshot) {
  if (snapshot.audioFrame) {
    return snapshot.audioFrame.hostEstimatedEpochMs;
  }

  if (!snapshot.clock || typeof performance === "undefined") {
    return null;
  }

  return performance.timeOrigin + performance.now() + snapshot.clock.offsetMs;
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
    ((pulse.emittedAtHostEpochMs -
      snapshot.audioFrame.hostEstimatedEpochMs) /
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
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      return new AudioContextClass();
    },
  });
  void schedulerRef.current.schedule(pulse, { hostEpochNowMs: now });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
