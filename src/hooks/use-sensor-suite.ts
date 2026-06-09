"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  audioFrameTimestamp,
  estimateClockOffset,
  robustClockModel,
  type AudioFrameTimestamp,
  type ClockExchange,
  type ClockModel,
} from "@/lib/timing/clock-sync";

type SensorState = "idle" | "active" | "blocked";

export type SensorSnapshot = {
  mic: SensorState;
  motion: SensorState;
  heading: SensorState;
  location: SensorState;
  micLevel: number;
  sampleRate: number | null;
  audioFrame: AudioFrameTimestamp | null;
  headingDegrees: number | null;
  locationAccuracyMeters: number | null;
  clock: ClockModel | null;
};

const idleSnapshot: SensorSnapshot = {
  mic: "idle",
  motion: "idle",
  heading: "idle",
  location: "idle",
  micLevel: 0,
  sampleRate: null,
  audioFrame: null,
  headingDegrees: null,
  locationAccuracyMeters: null,
  clock: null,
};

type PermissionEventConstructor = {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

export function useSensorSuite() {
  const [snapshot, setSnapshot] = useState<SensorSnapshot>(idleSnapshot);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const clockTimerRef = useRef<number | null>(null);
  const motionActiveRef = useRef(false);
  const headingActiveRef = useRef(false);
  const clockExchangesRef = useRef<ClockExchange[]>([]);

  const stop = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (clockTimerRef.current !== null) {
      window.clearInterval(clockTimerRef.current);
      clockTimerRef.current = null;
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    window.removeEventListener("deviceorientation", handleOrientation);
    window.removeEventListener("devicemotion", handleMotion);
    motionActiveRef.current = false;
    headingActiveRef.current = false;
    clockExchangesRef.current = [];
    setSnapshot(idleSnapshot);
  }, []);

  const start = useCallback(async () => {
    await requestMotionPermission();
    await syncClock(setSnapshot, clockExchangesRef);
    clockTimerRef.current = window.setInterval(
      () => void syncClock(setSnapshot, clockExchangesRef),
      2_000,
    );
    window.addEventListener("deviceorientation", handleOrientation);
    window.addEventListener("devicemotion", handleMotion);

    setSnapshot((current) => ({
      ...current,
      motion: "idle",
      heading: "idle",
    }));

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      mediaStreamRef.current = stream;

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);

      const read = () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          sum += sample * sample;
        }
        const micLevel = Math.sqrt(sum / samples.length);
        setSnapshot((current) => ({
          ...current,
          mic: "active",
          micLevel,
          sampleRate: audioContext.sampleRate,
          audioFrame: current.clock
            ? timestampAudioFrame(audioContext, current.clock)
            : null,
          motion: motionActiveRef.current ? "active" : current.motion,
          heading: headingActiveRef.current ? "active" : current.heading,
        }));
        animationRef.current = requestAnimationFrame(read);
      };
      read();
    } catch {
      setSnapshot((current) => ({
        ...current,
        mic: "blocked",
      }));
    }

    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setSnapshot((current) => ({
            ...current,
            location: "active",
            locationAccuracyMeters: position.coords.accuracy,
          }));
        },
        () => {
          setSnapshot((current) => ({
            ...current,
            location: "blocked",
          }));
        },
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 4_000 },
      );
    }
  }, []);

  useEffect(() => stop, [stop]);

  return { snapshot, start, stop };

  function handleOrientation(event: DeviceOrientationEvent) {
    headingActiveRef.current = true;
    setSnapshot((current) => ({
      ...current,
      heading: "active",
      headingDegrees: event.alpha ?? current.headingDegrees,
    }));
  }

  function handleMotion() {
    motionActiveRef.current = true;
    setSnapshot((current) => ({
      ...current,
      motion: "active",
    }));
  }
}

async function requestMotionPermission() {
  const orientation = DeviceOrientationEvent as unknown as PermissionEventConstructor;
  const motion = DeviceMotionEvent as unknown as PermissionEventConstructor;

  await Promise.allSettled([
    orientation.requestPermission?.(),
    motion.requestPermission?.(),
  ]);
}

async function syncClock(
  setSnapshot: Dispatch<SetStateAction<SensorSnapshot>>,
  exchangesRef: MutableRefObject<ClockExchange[]>,
) {
  try {
    const clientPerfOriginEpochMs = Date.now() - performance.now();
    const clientSendPerfMs = performance.now();
    const response = await fetch("/api/time/echo", { method: "POST" });
    const clientReceivePerfMs = performance.now();
    const server = (await response.json()) as {
      serverReceiveEpochMs: number;
      serverSendEpochMs: number;
    };

    const exchange: ClockExchange = {
      clientPerfOriginEpochMs,
      clientSendPerfMs,
      serverReceiveEpochMs: server.serverReceiveEpochMs,
      serverSendEpochMs: server.serverSendEpochMs,
      clientReceivePerfMs,
    };
    const estimate = estimateClockOffset(exchange);
    exchangesRef.current = [...exchangesRef.current, exchange]
      .slice(-12)
      .filter((item) => estimateClockOffset(item).roundTripMs < 750);
    const clock = robustClockModel(exchangesRef.current);

    setSnapshot((current) => ({
      ...current,
      clock,
    }));

    return estimate;
  } catch {
    return null;
  }
}

function timestampAudioFrame(
  audioContext: AudioContext,
  clock: ClockModel,
): AudioFrameTimestamp {
  const outputTimestamp = audioContext.getOutputTimestamp?.();
  const audioContextTimeSeconds =
    outputTimestamp?.contextTime ?? audioContext.currentTime;
  const performanceNowMs = outputTimestamp?.performanceTime ?? performance.now();
  const sampleIndex = Math.round(
    audioContextTimeSeconds * audioContext.sampleRate,
  );

  return audioFrameTimestamp({
    audioContextTimeSeconds,
    sampleIndex,
    sampleRate: audioContext.sampleRate,
    clientPerfOriginEpochMs: performance.timeOrigin || Date.now() - performance.now(),
    performanceNowMs,
    clockOffsetMs: clock.offsetMs,
    clockUncertaintyMs: clock.uncertaintyMs,
  });
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
