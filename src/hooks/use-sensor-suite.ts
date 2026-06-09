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
  audioSampleTimestamp,
  estimateClockOffset,
  retainClockExchanges,
  robustClockModel,
  type AudioFrameTimestamp,
  type ClockExchange,
  type ClockModel,
} from "@/lib/timing/clock-sync";
import type { AudioPulseWindow } from "@/lib/calibration/pulse";
import {
  RollingSampleBuffer,
  type RollingSampleWindow,
} from "@/lib/acoustics/rolling-buffer";
import {
  StreamingPulseMatcher,
} from "@/lib/acoustics/streaming-pulse-matcher";
import type { AcousticPulse } from "@/lib/session/registry";

type SensorState = "idle" | "active" | "blocked";

export type SensorSnapshot = {
  mic: SensorState;
  motion: SensorState;
  heading: SensorState;
  location: SensorState;
  micLevel: number;
  sampleRate: number | null;
  audioFrame: AudioFrameTimestamp | null;
  audioWindow: AudioPulseWindow | null;
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
  audioWindow: null,
  headingDegrees: null,
  locationAccuracyMeters: null,
  clock: null,
};

const CLOCK_SYNC_INTERVAL_MS = 1_000;
const CLOCK_SYNC_WARMUP_COUNT = 4;
const CLOCK_SYNC_WARMUP_SPACING_MS = 160;
const ANALYSER_WINDOW_SAMPLES = 4096;
const ROLLING_AUDIO_HISTORY_SAMPLES = 48_000;
const STREAMING_MATCH_MAX_LATE_MS = 45;

type PermissionEventConstructor = {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

export function useSensorSuite(activePulse: AcousticPulse | null = null) {
  const [snapshot, setSnapshot] = useState<SensorSnapshot>(idleSnapshot);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioWorkletRef = useRef<AudioWorkletNode | null>(null);
  const rollingAudioRef = useRef<RollingSampleBuffer | null>(null);
  const streamingMatcherRef = useRef<StreamingPulseMatcher | null>(null);
  const animationRef = useRef<number | null>(null);
  const clockTimerRef = useRef<number | null>(null);
  const clockSyncRunRef = useRef(0);
  const motionActiveRef = useRef(false);
  const headingActiveRef = useRef(false);
  const clockExchangesRef = useRef<ClockExchange[]>([]);
  const clockModelRef = useRef<ClockModel | null>(null);
  const activePulseRef = useRef<AcousticPulse | null>(activePulse);

  const trackPulse = useCallback((pulse: AcousticPulse | null) => {
    activePulseRef.current = pulse;
    updateStreamingMatcherPulse(
      pulse,
      audioContextRef.current,
      clockModelRef.current,
      streamingMatcherRef.current,
    );
  }, []);

  const stop = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (clockTimerRef.current !== null) {
      window.clearInterval(clockTimerRef.current);
      clockTimerRef.current = null;
    }
    clockSyncRunRef.current += 1;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    audioWorkletRef.current?.disconnect();
    audioWorkletRef.current = null;
    rollingAudioRef.current = null;
    streamingMatcherRef.current?.clear();
    streamingMatcherRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    window.removeEventListener("deviceorientation", handleOrientation);
    window.removeEventListener("devicemotion", handleMotion);
    motionActiveRef.current = false;
    headingActiveRef.current = false;
    clockExchangesRef.current = [];
    clockModelRef.current = null;
    activePulseRef.current = null;
    setSnapshot(idleSnapshot);
  }, []);

  const start = useCallback(async () => {
    const syncRun = clockSyncRunRef.current + 1;
    clockSyncRunRef.current = syncRun;
    await requestMotionPermission();
    await syncClock(setSnapshot, clockExchangesRef, (clock) => {
      clockModelRef.current = clock;
      updateStreamingMatcherPulse(
        activePulseRef.current,
        audioContextRef.current,
        clock,
        streamingMatcherRef.current,
      );
    });
    void warmClockSync(
      setSnapshot,
      clockExchangesRef,
      () => clockSyncRunRef.current === syncRun,
      (clock) => {
        clockModelRef.current = clock;
        updateStreamingMatcherPulse(
          activePulseRef.current,
          audioContextRef.current,
          clock,
          streamingMatcherRef.current,
        );
      },
    );
    clockTimerRef.current = window.setInterval(
      () =>
        void syncClock(setSnapshot, clockExchangesRef, (clock) => {
          clockModelRef.current = clock;
          updateStreamingMatcherPulse(
            activePulseRef.current,
            audioContextRef.current,
            clock,
            streamingMatcherRef.current,
          );
        }),
      CLOCK_SYNC_INTERVAL_MS,
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
      if (audioContext.state === "suspended") {
        await audioContext.resume().catch(() => undefined);
      }
      audioContextRef.current = audioContext;
      const rollingAudio = new RollingSampleBuffer(ROLLING_AUDIO_HISTORY_SAMPLES);
      rollingAudioRef.current = rollingAudio;
      const streamingMatcher = new StreamingPulseMatcher({
        sampleRate: audioContext.sampleRate,
        historySamples: ROLLING_AUDIO_HISTORY_SAMPLES,
        minScore: 0.5,
        minPeakRatio: 2.2,
      });
      streamingMatcherRef.current = streamingMatcher;
      updateStreamingMatcherPulse(
        activePulseRef.current,
        audioContext,
        clockModelRef.current,
        streamingMatcher,
      );
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = ANALYSER_WINDOW_SAMPLES;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      audioWorkletRef.current = await startAudioWorkletCapture(
        audioContext,
        source,
        rollingAudio,
        streamingMatcher,
        (window) => {
          const clock = clockModelRef.current;
          if (!clock) {
            return;
          }
          setSnapshot((current) => ({
            ...current,
            ...audioWindowFromRollingWindow(audioContext, window, clock),
          }));
        },
      );
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
          ...timestampCurrentAudioWindow(
            audioContext,
            samples,
            rollingAudioRef.current,
            current.clock,
          ),
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
  useEffect(() => {
    trackPulse(activePulse);
  }, [activePulse, trackPulse]);

  return { snapshot, start, stop, trackPulse };

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
  onClock?: (clock: ClockModel) => void,
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
    exchangesRef.current = retainClockExchanges(exchangesRef.current, exchange);
    const clock = robustClockModel(exchangesRef.current);
    onClock?.(clock);

    setSnapshot((current) => ({
      ...current,
      clock,
    }));

    return estimate;
  } catch {
    return null;
  }
}

async function warmClockSync(
  setSnapshot: Dispatch<SetStateAction<SensorSnapshot>>,
  exchangesRef: MutableRefObject<ClockExchange[]>,
  isCurrentRun: () => boolean,
  onClock?: (clock: ClockModel) => void,
) {
  for (let index = 0; index < CLOCK_SYNC_WARMUP_COUNT; index += 1) {
    await wait(CLOCK_SYNC_WARMUP_SPACING_MS);
    if (!isCurrentRun()) {
      return;
    }
    await syncClock(setSnapshot, exchangesRef, onClock);
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function timestampCurrentAudioWindow(
  audioContext: AudioContext,
  analyserSamples: Float32Array,
  rollingAudio: RollingSampleBuffer | null,
  clock: ClockModel | null,
): Pick<SensorSnapshot, "audioFrame" | "audioWindow"> {
  if (!clock) {
    return {
      audioFrame: null,
      audioWindow: null,
    };
  }

  const audioFrame = timestampAudioFrame(audioContext, clock);
  const latestRollingWindow = rollingAudio?.latest(ROLLING_AUDIO_HISTORY_SAMPLES);
  const fallbackSamples = new Float32Array(analyserSamples);
  const windowSamples = latestRollingWindow?.samples ?? fallbackSamples;
  const startSampleIndex =
    latestRollingWindow?.startSampleIndex ??
    Math.max(0, audioFrame.sampleIndex - fallbackSamples.length);

  return {
    audioFrame,
    audioWindow: {
      samples: windowSamples,
      sampleRate: audioFrame.sampleRate,
      startSampleIndex,
      anchorAudioContextTimeSeconds: audioFrame.audioContextTimeSeconds,
      anchorPerformanceNowMs: audioFrame.performanceNowMs,
      clientPerfOriginEpochMs: audioFrame.clientPerfOriginEpochMs,
      clockOffsetMs: audioFrame.clockOffsetMs,
      clockUncertaintyMs: audioFrame.clockUncertaintyMs,
    },
  };
}

async function startAudioWorkletCapture(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  rollingAudio: RollingSampleBuffer,
  streamingMatcher: StreamingPulseMatcher,
  onDetectionWindow: (window: RollingSampleWindow) => void,
) {
  if (!audioContext.audioWorklet) {
    return null;
  }

  try {
    await audioContext.audioWorklet.addModule(
      "/audio/blackmagic-capture-worklet.js",
    );
    const node = new AudioWorkletNode(audioContext, "blackmagic-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });

    node.port.onmessage = (event: MessageEvent<CaptureWorkletMessage>) => {
      if (
        event.data?.type !== "samples" ||
        !(event.data.samples instanceof ArrayBuffer)
      ) {
        return;
      }

      const samples = new Float32Array(event.data.samples);
      rollingAudio.append(samples, event.data.startSampleIndex);
      const detection = streamingMatcher.append(
        samples,
        event.data.startSampleIndex,
      );
      if (detection) {
        const window = streamingMatcher.latestWindow();
        if (window) {
          onDetectionWindow(window);
        }
      }
    };
    source.connect(node);
    return node;
  } catch {
    return null;
  }
}

function updateStreamingMatcherPulse(
  pulse: AcousticPulse | null,
  audioContext: AudioContext | null,
  clock: ClockModel | null,
  matcher: StreamingPulseMatcher | null,
) {
  if (!pulse || !audioContext || !clock || !matcher) {
    matcher?.track(null);
    return;
  }

  matcher.track({
    id: pulse.id,
    frequencyHz: pulse.frequencyHz,
    endFrequencyHz: pulse.endFrequencyHz,
    durationMs: pulse.durationMs,
    expectedStartSampleIndex: hostEpochMsToSampleIndex(
      pulse.emittedAtHostEpochMs,
      audioContext,
      clock,
    ),
    maxLateSamples: Math.ceil(
      (STREAMING_MATCH_MAX_LATE_MS / 1_000) * audioContext.sampleRate,
    ),
  });
}

function hostEpochMsToSampleIndex(
  hostEpochMs: number,
  audioContext: AudioContext,
  clock: ClockModel,
) {
  const outputTimestamp = audioContext.getOutputTimestamp?.();
  const anchorAudioContextTimeSeconds = validTimestamp(
    outputTimestamp?.contextTime,
    audioContext.currentTime,
  );
  const anchorPerformanceNowMs = validTimestamp(
    outputTimestamp?.performanceTime,
    performance.now(),
  );
  const clientPerformanceNowMs =
    hostEpochMs -
    (performance.timeOrigin || Date.now() - performance.now()) -
    clock.offsetMs;
  const targetAudioContextTimeSeconds =
    anchorAudioContextTimeSeconds +
    (clientPerformanceNowMs - anchorPerformanceNowMs) / 1_000;

  return Math.max(
    0,
    Math.round(targetAudioContextTimeSeconds * audioContext.sampleRate),
  );
}

function audioWindowFromRollingWindow(
  audioContext: AudioContext,
  window: RollingSampleWindow,
  clock: ClockModel,
): Pick<SensorSnapshot, "audioFrame" | "audioWindow"> {
  const audioFrame = timestampAudioFrame(audioContext, clock);

  return {
    audioFrame,
    audioWindow: {
      samples: window.samples,
      sampleRate: audioFrame.sampleRate,
      startSampleIndex: window.startSampleIndex,
      anchorAudioContextTimeSeconds: audioFrame.audioContextTimeSeconds,
      anchorPerformanceNowMs: audioFrame.performanceNowMs,
      clientPerfOriginEpochMs: audioFrame.clientPerfOriginEpochMs,
      clockOffsetMs: audioFrame.clockOffsetMs,
      clockUncertaintyMs: audioFrame.clockUncertaintyMs,
    },
  };
}

function timestampAudioFrame(
  audioContext: AudioContext,
  clock: ClockModel,
): AudioFrameTimestamp {
  const outputTimestamp = audioContext.getOutputTimestamp?.();
  const audioContextTimeSeconds = validTimestamp(
    outputTimestamp?.contextTime,
    audioContext.currentTime,
  );
  const performanceNowMs = validTimestamp(
    outputTimestamp?.performanceTime,
    performance.now(),
  );
  const sampleIndex = Math.round(
    audioContextTimeSeconds * audioContext.sampleRate,
  );

  return audioSampleTimestamp({
    anchorAudioContextTimeSeconds: audioContextTimeSeconds,
    anchorPerformanceNowMs: performanceNowMs,
    sampleIndex,
    sampleRate: audioContext.sampleRate,
    clientPerfOriginEpochMs: performance.timeOrigin || Date.now() - performance.now(),
    clockOffsetMs: clock.offsetMs,
    clockUncertaintyMs: clock.uncertaintyMs,
  });
}

function validTimestamp(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type CaptureWorkletMessage = {
  type: "samples";
  samples: ArrayBuffer;
  startSampleIndex: number;
  sampleRate: number;
};
