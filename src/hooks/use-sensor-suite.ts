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
  projectClockModel,
  retainClockExchanges,
  robustClockModel,
  type AudioFrameTimestamp,
  type ClockExchange,
  type ClockModel,
} from "@/lib/timing/clock-sync";
import type { AudioPulseWindow } from "@/lib/calibration/pulse";
import { createSampledToneObservation } from "@/lib/calibration/pulse";
import {
  RollingSampleBuffer,
  type RollingSampleWindow,
} from "@/lib/acoustics/rolling-buffer";
import {
  StreamingPulseMatcher,
  type StreamingPulseDetection,
} from "@/lib/acoustics/streaming-pulse-matcher";
import {
  detectVoiceActivityEvent,
  type VoiceActivityGate,
} from "@/lib/acoustics/voice-activity";
import { captureAudioSnippet } from "@/lib/acoustics/audio-snippet";
import { createSpeechFingerprint } from "@/lib/acoustics/speech-fingerprint";
import type {
  AcousticObservation,
  AcousticPulse,
  CaptureProcessingReport,
} from "@/lib/session/registry";
import type { VoiceActivityEvent } from "@/lib/session/audio-events";
import {
  idleMotionMetadata,
  motionMetadataFromReading,
  type MotionSensorMetadata,
} from "@/lib/sensors/fusion";

type SensorState = "idle" | "active" | "blocked";

export type { CaptureProcessingReport } from "@/lib/session/registry";

export type SensorSnapshot = MotionSensorMetadata & {
  mic: SensorState;
  motion: SensorState;
  heading: SensorState;
  location: SensorState;
  micLevel: number;
  sampleRate: number | null;
  audioFrame: AudioFrameTimestamp | null;
  audioWindow: AudioPulseWindow | null;
  pulseObservation: AcousticObservation | null;
  voiceEvent: VoiceActivityEvent | null;
  headingDegrees: number | null;
  orientationBetaDegrees: number | null;
  orientationGammaDegrees: number | null;
  orientationAbsolute: boolean | null;
  locationLatitude: number | null;
  locationLongitude: number | null;
  locationAccuracyMeters: number | null;
  locationAltitudeMeters: number | null;
  locationAltitudeAccuracyMeters: number | null;
  locationHeadingDegrees: number | null;
  locationSpeedMetersPerSecond: number | null;
  locationCapturedAtEpochMs: number | null;
  clock: ClockModel | null;
  captureProcessing: CaptureProcessingReport | null;
  audioContextState: AudioContextState | null;
};

const idleSnapshot: SensorSnapshot = {
  ...idleMotionMetadata,
  mic: "idle",
  motion: "idle",
  heading: "idle",
  location: "idle",
  micLevel: 0,
  sampleRate: null,
  audioFrame: null,
  audioWindow: null,
  pulseObservation: null,
  voiceEvent: null,
  headingDegrees: null,
  orientationBetaDegrees: null,
  orientationGammaDegrees: null,
  orientationAbsolute: null,
  locationLatitude: null,
  locationLongitude: null,
  locationAccuracyMeters: null,
  locationAltitudeMeters: null,
  locationAltitudeAccuracyMeters: null,
  locationHeadingDegrees: null,
  locationSpeedMetersPerSecond: null,
  locationCapturedAtEpochMs: null,
  clock: null,
  captureProcessing: null,
  audioContextState: null,
};

const CLOCK_SYNC_INTERVAL_MS = 1_000;
const CLOCK_SYNC_WARMUP_COUNT = 4;
const CLOCK_SYNC_WARMUP_SPACING_MS = 160;
const MAX_CLOCK_SEARCH_SLACK_MS = 120;
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
  const locationWatchRef = useRef<number | null>(null);
  const clockSyncRunRef = useRef(0);
  const motionActiveRef = useRef(false);
  const headingActiveRef = useRef(false);
  const motionMetadataRef = useRef<MotionSensorMetadata>(idleMotionMetadata);
  const clockExchangesRef = useRef<ClockExchange[]>([]);
  const clockModelRef = useRef<ClockModel | null>(null);
  const activePulseRef = useRef<AcousticPulse | null>(activePulse);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const lifecycleCleanupRef = useRef<(() => void) | null>(null);
  const voiceGateRef = useRef<VoiceActivityGate>({
    open: false,
    lastEventHostEpochMs: null,
  });

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
    if (locationWatchRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(locationWatchRef.current);
      locationWatchRef.current = null;
    }
    clockSyncRunRef.current += 1;
    lifecycleCleanupRef.current?.();
    lifecycleCleanupRef.current = null;
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;

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
    motionMetadataRef.current = idleMotionMetadata;
    clockExchangesRef.current = [];
    clockModelRef.current = null;
    activePulseRef.current = null;
    voiceGateRef.current = { open: false, lastEventHostEpochMs: null };
    setSnapshot(idleSnapshot);
  }, []);

  const start = useCallback(async () => {
    const syncRun = clockSyncRunRef.current + 1;
    clockSyncRunRef.current = syncRun;
    window.addEventListener("deviceorientation", handleOrientation);
    window.addEventListener("devicemotion", handleMotion);

    setSnapshot((current) => ({
      ...current,
      motion: "idle",
      heading: "idle",
    }));

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume().catch(() => undefined);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      mediaStreamRef.current = stream;

      // Verify what the browser actually granted: iOS Safari treats audio
      // constraints as best-effort and active voice processing attenuates the
      // near-ultrasound chirp band.
      const audioTrack = stream.getAudioTracks()[0] ?? null;
      const trackSettings = audioTrack?.getSettings?.() ?? null;
      const captureProcessing: CaptureProcessingReport = {
        echoCancellation: booleanOrNull(trackSettings?.echoCancellation),
        noiseSuppression: booleanOrNull(trackSettings?.noiseSuppression),
        autoGainControl: booleanOrNull(trackSettings?.autoGainControl),
        rawCaptureVerified:
          trackSettings?.echoCancellation === false &&
          trackSettings?.noiseSuppression === false &&
          trackSettings?.autoGainControl === false,
      };

      if (audioContext.state === "suspended") {
        await audioContext.resume().catch(() => undefined);
      }
      setSnapshot((current) => ({
        ...current,
        captureProcessing,
        audioContextState: audioContext.state,
      }));
      lifecycleCleanupRef.current = attachAudioLifecycle({
        audioContext,
        audioTrack,
        wakeLockRef,
        setSnapshot,
        resyncClock: () =>
          void syncClock(setSnapshot, clockExchangesRef, (clock) => {
            clockModelRef.current = clock;
          }),
      });
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
        (detection, window) => {
          const clock = clockModelRef.current;
          if (!clock) {
            return;
          }
          const timing = audioWindowFromRollingWindow(audioContext, window, clock);
          setSnapshot((current) => ({
            ...current,
            ...timing,
            pulseObservation:
              createPulseObservationFromStreamingDetection({
                detection,
                audioWindow: timing.audioWindow,
                pulse: activePulseRef.current,
              }) ?? current.pulseObservation,
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
        const timing = timestampCurrentAudioWindow(
          audioContext,
          samples,
          rollingAudioRef.current,
          clockModelRef.current,
        );
        const voiceActivity = detectVoiceActivityEvent({
          gate: voiceGateRef.current,
          micLevel,
          frame: timing.audioFrame,
          motionStability: motionMetadataRef.current.motionStability,
        });
        voiceGateRef.current = voiceActivity.gate;
        const voiceEvent = voiceActivity.event
          ? attachSpeechFingerprint(voiceActivity.event, timing.audioWindow)
          : null;
        setSnapshot((current) => ({
          ...current,
          mic: "active",
          micLevel,
          sampleRate: audioContext.sampleRate,
          ...timing,
          voiceEvent: voiceEvent ?? current.voiceEvent,
          motion: motionActiveRef.current ? "active" : current.motion,
          heading: headingActiveRef.current ? "active" : current.heading,
        }));
        animationRef.current = requestAnimationFrame(read);
      };
      read();

      void requestMotionPermission();
      void syncClock(setSnapshot, clockExchangesRef, (clock) => {
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
    } catch {
      void audioContext.close().catch(() => undefined);
      audioContextRef.current = null;
      setSnapshot((current) => ({
        ...current,
        mic: "blocked",
        audioContextState: null,
      }));
      return;
    }

    if ("geolocation" in navigator) {
      locationWatchRef.current = navigator.geolocation.watchPosition(
        (position) => {
          setSnapshot((current) => ({
            ...current,
            location: "active",
            locationLatitude: position.coords.latitude,
            locationLongitude: position.coords.longitude,
            locationAccuracyMeters: position.coords.accuracy,
            locationAltitudeMeters: position.coords.altitude,
            locationAltitudeAccuracyMeters: position.coords.altitudeAccuracy,
            locationHeadingDegrees: position.coords.heading,
            locationSpeedMetersPerSecond: position.coords.speed,
            locationCapturedAtEpochMs: position.timestamp,
          }));
        },
        () => {
          setSnapshot((current) => ({
            ...current,
            location: "blocked",
          }));
        },
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 5_000 },
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
    const webkitHeading = (
      event as DeviceOrientationEvent & { webkitCompassHeading?: number }
    ).webkitCompassHeading;
    setSnapshot((current) => ({
      ...current,
      heading: "active",
      headingDegrees: webkitHeading ?? event.alpha ?? current.headingDegrees,
      orientationBetaDegrees: event.beta ?? current.orientationBetaDegrees,
      orientationGammaDegrees: event.gamma ?? current.orientationGammaDegrees,
      orientationAbsolute: event.absolute ?? current.orientationAbsolute,
    }));
  }

  function handleMotion(event: DeviceMotionEvent) {
    motionActiveRef.current = true;
    const metadata = motionMetadataFromReading({
      acceleration: event.acceleration,
      accelerationIncludingGravity: event.accelerationIncludingGravity,
      rotationRate: event.rotationRate,
      intervalMs: event.interval,
      capturedAtClientPerfMs: performance.now(),
    });
    motionMetadataRef.current = metadata;
    setSnapshot((current) => ({
      ...current,
      motion: "active",
      ...metadata,
    }));
  }
}

// iOS Safari suspends the audio context on tab backgrounding, phone calls,
// and Siri, throttles timers while hidden, and auto-locks the screen during a
// passive listening session. This wires the recovery paths: resume the
// context on state changes and visibility, hold a screen wake lock so the
// session survives, surface mic-track loss, and re-sync the clock as soon as
// the page returns (it drifted while throttled).
function attachAudioLifecycle({
  audioContext,
  audioTrack,
  wakeLockRef,
  setSnapshot,
  resyncClock,
}: {
  audioContext: AudioContext;
  audioTrack: MediaStreamTrack | null;
  wakeLockRef: MutableRefObject<WakeLockSentinel | null>;
  setSnapshot: Dispatch<SetStateAction<SensorSnapshot>>;
  resyncClock: () => void;
}) {
  const requestWakeLock = async () => {
    try {
      wakeLockRef.current =
        (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      wakeLockRef.current = null;
    }
  };

  const onAudioStateChange = () => {
    setSnapshot((current) => ({
      ...current,
      audioContextState: audioContext.state,
    }));
    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => undefined);
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => undefined);
    }
    void requestWakeLock();
    resyncClock();
  };

  const onTrackEnded = () => {
    setSnapshot((current) => ({ ...current, mic: "blocked" }));
  };

  audioContext.addEventListener("statechange", onAudioStateChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  audioTrack?.addEventListener("ended", onTrackEnded);
  void requestWakeLock();

  return () => {
    audioContext.removeEventListener("statechange", onAudioStateChange);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    audioTrack?.removeEventListener("ended", onTrackEnded);
  };
}

function booleanOrNull(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

async function requestMotionPermission() {
  const orientation =
    typeof DeviceOrientationEvent === "undefined"
      ? null
      : (DeviceOrientationEvent as unknown as PermissionEventConstructor);
  const motion =
    typeof DeviceMotionEvent === "undefined"
      ? null
      : (DeviceMotionEvent as unknown as PermissionEventConstructor);

  await Promise.allSettled([
    orientation?.requestPermission?.(),
    motion?.requestPermission?.(),
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
      serverInstanceId?: string | null;
    };

    const exchange: ClockExchange = {
      clientPerfOriginEpochMs,
      clientSendPerfMs,
      serverReceiveEpochMs: server.serverReceiveEpochMs,
      serverSendEpochMs: server.serverSendEpochMs,
      clientReceivePerfMs,
      serverInstanceId: server.serverInstanceId ?? null,
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

function attachSpeechFingerprint(
  event: VoiceActivityEvent,
  audioWindow: AudioPulseWindow | null,
): VoiceActivityEvent {
  if (!audioWindow) {
    return event;
  }

  const audioFingerprint = createSpeechFingerprint({
    samples: audioWindow.samples,
    sampleRate: audioWindow.sampleRate,
    startSampleIndex: audioWindow.startSampleIndex,
    centerSampleIndex: event.sampleIndex,
    windowMs: 240,
    bins: 32,
    alignmentBins: 96,
  });
  // The raw-audio snippet is what lets the room reconciler run GCC-PHAT over
  // what this microphone actually heard; the fingerprint stays as a cheap
  // fallback when a peer cannot provide a snippet.
  const audioSnippet = captureAudioSnippet({
    samples: audioWindow.samples,
    sampleRate: audioWindow.sampleRate,
    startSampleIndex: audioWindow.startSampleIndex,
    centerSampleIndex: event.sampleIndex,
    windowMs: 240,
  });

  return {
    ...event,
    audioFingerprint,
    audioSnippet,
  };
}

async function startAudioWorkletCapture(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  rollingAudio: RollingSampleBuffer,
  streamingMatcher: StreamingPulseMatcher,
  onDetectionWindow: (
    detection: StreamingPulseDetection,
    window: RollingSampleWindow,
  ) => void,
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
          onDetectionWindow(detection, window);
        }
      }
    };
    source.connect(node);
    return node;
  } catch {
    return null;
  }
}

function createPulseObservationFromStreamingDetection({
  detection,
  audioWindow,
  pulse,
}: {
  detection: StreamingPulseDetection;
  audioWindow: AudioPulseWindow | null;
  pulse: AcousticPulse | null;
}) {
  if (!audioWindow || !pulse || pulse.id !== detection.pulseId) {
    return null;
  }

  return createSampledToneObservation({
    pulse,
    detectedSampleIndex: detection.startSampleIndex,
    sampleRate: audioWindow.sampleRate,
    anchorAudioContextTimeSeconds: audioWindow.anchorAudioContextTimeSeconds,
    anchorPerformanceNowMs: audioWindow.anchorPerformanceNowMs,
    clientPerfOriginEpochMs: audioWindow.clientPerfOriginEpochMs,
    clockOffsetMs: audioWindow.clockOffsetMs,
    clockUncertaintyMs: audioWindow.clockUncertaintyMs,
    amplitude: detection.detection.amplitude,
    detectionConfidence: detection.detection.confidence,
  });
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

  // Widen the detector search window by the current clock error bound so a
  // pulse is not missed just because this device's host-clock estimate is
  // early or late. Capped so a degraded clock cannot explode the search cost.
  const projected = projectClockModel(clock, performance.now());
  const clockSlackMs = Math.min(
    MAX_CLOCK_SEARCH_SLACK_MS,
    Math.max(0, Number.isFinite(projected.maxErrorMs) ? projected.maxErrorMs : MAX_CLOCK_SEARCH_SLACK_MS),
  );
  const clockSlackSamples = Math.ceil(
    (clockSlackMs / 1_000) * audioContext.sampleRate,
  );

  matcher.track({
    id: pulse.id,
    frequencyHz: pulse.frequencyHz,
    endFrequencyHz: pulse.endFrequencyHz,
    durationMs: pulse.durationMs,
    expectedStartSampleIndex: Math.max(
      0,
      hostEpochMsToSampleIndex(pulse.emittedAtHostEpochMs, audioContext, clock) -
        clockSlackSamples,
    ),
    maxLateSamples:
      Math.ceil((STREAMING_MATCH_MAX_LATE_MS / 1_000) * audioContext.sampleRate) +
      2 * clockSlackSamples,
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
    projectClockModel(clock, performance.now()).offsetMs;
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
  // Project the clock to "now" so drift since the last echo exchange moves
  // the offset instead of silently widening the error, and staleness honestly
  // widens the published uncertainty.
  const projected = projectClockModel(clock, performanceNowMs);

  return audioSampleTimestamp({
    anchorAudioContextTimeSeconds: audioContextTimeSeconds,
    anchorPerformanceNowMs: performanceNowMs,
    sampleIndex,
    sampleRate: audioContext.sampleRate,
    clientPerfOriginEpochMs: performance.timeOrigin || Date.now() - performance.now(),
    clockOffsetMs: projected.offsetMs,
    clockUncertaintyMs: projected.uncertaintyMs,
    clockQuality: clock.quality,
    clockMaxErrorMs: projected.maxErrorMs,
    clockBestRoundTripMs: clock.bestRoundTripMs,
    clockJitterMs: clock.jitterMs,
    clockSamplesUsed: clock.samplesUsed,
    clockOutliersRejected: clock.outliersRejected,
    clockOffsetStabilityMs: clock.offsetStabilityMs,
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
