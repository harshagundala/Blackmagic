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
import { createPhoneMarkers } from "@/lib/blackmagic/phone-markers";
import {
  calibrationEventKey,
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
  const publishedObservationRef = useRef<AcousticObservation | null>(null);
  const flushedCalibrationEventRef = useRef("");
  const pulseSchedulerRef = useRef<PulseToneScheduler | null>(null);
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
            publishedObservationRef.current?.pulseId ?? "",
          );

    if (!observation) {
      return;
    }

    if (
      !shouldPublishAcousticObservation(publishedObservationRef.current, observation)
    ) {
      return;
    }

    publishedObservationRef.current = observation;
    calibrationRef.current = {
      acousticPulse: calibrationRef.current.acousticPulse ?? null,
      acousticObservation: observation,
    };
    flushCalibrationEvent(
      calibrationEventKey(
        "observation",
        acousticObservationPublishKey(observation),
      ),
    );
  }, [flushCalibrationEvent, phase, sensors.snapshot]);

  const pulse =
    phase === "listening"
      ? Math.min(1, Math.max(0.12, sensors.snapshot.micLevel * 24))
      : 0.16;
  const phoneMarkers = createPhoneMarkers(
    constellation?.devices.filter(
      (device) => device.deviceId !== deviceId,
    ) ?? [],
  );

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
