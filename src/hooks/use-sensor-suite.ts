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
  projectClockModel,
  retainClockExchanges,
  selectClockModel,
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
import {
  CaptureRecorder,
  type RecordedTake,
} from "@/lib/recording/capture-recorder";
import { createSpeechFingerprint } from "@/lib/acoustics/speech-fingerprint";
import { buildWaveChunk, WaveSeries } from "@/lib/waveform/wave-series";
import type {
  AcousticObservation,
  AcousticPulse,
  AudioContextRunState,
  CaptureProcessingReport,
} from "@/lib/session/registry";
import type { VoiceActivityEvent } from "@/lib/session/audio-events";
import {
  idleMotionMetadata,
  motionMetadataFromReading,
  type MotionSensorMetadata,
} from "@/lib/sensors/fusion";

type SensorState = "idle" | "active" | "blocked";

export type ClockAuthority = "self" | "external";

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
  // iOS marks the capture track muted during interruptions (Siri, calls,
  // route changes); a muted track delivers silence while the system mic
  // indicator can stay on.
  trackMuted: boolean | null;
  // How many times the silent-capture watchdog has rebuilt or re-acquired
  // the pipeline this session, and the constraint mode currently live.
  captureRecoveries: number;
  captureMode: CaptureConstraintMode | null;
};

// "raw": voice processing disabled (acoustic work). "processed": browser
// default voice pipeline. "video": camera requested alongside the mic — on
// iOS this changes microphone selection/beamforming (the mic follows the
// camera) and possibly the audio session mode; the video track is held but
// never rendered.
export type CaptureConstraintMode = "raw" | "processed" | "video";

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
  trackMuted: null,
  captureRecoveries: 0,
  captureMode: null,
};

const CLOCK_SYNC_INTERVAL_MS = 1_000;
const CLOCK_SYNC_WARMUP_COUNT = 4;
const CLOCK_SYNC_WARMUP_SPACING_MS = 160;
// A live microphone never reads near digital silence for seconds — even a
// quiet room has a noise floor well above 1e-4 RMS. Sustained near-zeros
// from a "running" context mean the capture pipeline is broken: iOS
// sample-rate mismatch, a track muted by an interruption, or WebKit's
// "capture failure" states where the track silently never recovers. The
// recovery ladder follows what production WebRTC SDKs ship for iOS Safari:
// rebuild the graph on a fresh context, then stop the tracks and call
// getUserMedia again (no re-prompt), then fall back to processed (default
// constraint) capture, which uses a different iOS capture path.
const SILENT_CAPTURE_RMS = 1e-5;
// Between exact silence and a healthy noise floor sits a dead zone where a
// broken iOS capture path can leak faint processing noise. Recover from that
// band too, just on a longer fuse so a genuinely tomb-quiet room does not
// trigger churn.
const QUIET_CAPTURE_RMS = 3e-5;
const HEALTHY_CAPTURE_RMS = 1e-4;
const SILENT_CAPTURE_REBUILD_MS = 3_000;
const QUIET_CAPTURE_REBUILD_MS = 9_000;
const MAX_CAPTURE_RECOVERIES = 5;
// Envelope series shared with peers: 25 ms buckets, 16 per chunk (400 ms),
// sent every sensor frame (~220 ms) so one dropped frame costs nothing.
const WAVE_HISTORY_MS = 8_000;
const WAVE_BUCKET_MS = 25;
const WAVE_CHUNK_BUCKETS = 16;
const MAX_CLOCK_SEARCH_SLACK_MS = 120;
const ANALYSER_WINDOW_SAMPLES = 4096;
const ROLLING_AUDIO_HISTORY_SAMPLES = 48_000;
const STREAMING_MATCH_MAX_LATE_MS = 45;

type PermissionEventConstructor = {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

type CaptureGraph = {
  audioContext: AudioContext;
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  samples: Float32Array<ArrayBuffer>;
};

// The capture mode that actually produces audio is device-specific on iOS
// (raw capture is broken on some devices/routes). Remember what worked so a
// reload does not silently reset to a dead pipeline. Default is the
// browser's processed path — the one that works everywhere; "raw" is an
// acoustic-precision optimization to opt into once proven on the device.
const CAPTURE_MODE_STORAGE_KEY = "blackmagic.captureMode";

function loadStoredCaptureMode(): CaptureConstraintMode {
  if (typeof window === "undefined") {
    return "processed";
  }
  try {
    const value = window.localStorage.getItem(CAPTURE_MODE_STORAGE_KEY);
    // "video" never restores: it requires a camera prompt that cannot fire
    // at page load, so booting into it bricks the session.
    return value === "raw" || value === "processed" ? value : "processed";
  } catch {
    return "processed";
  }
}

function storeCaptureMode(mode: CaptureConstraintMode) {
  if (mode === "video") {
    return;
  }
  try {
    window.localStorage.setItem(CAPTURE_MODE_STORAGE_KEY, mode);
  } catch {
    // Private browsing: the session still works, it just will not remember.
  }
}

export function useSensorSuite(activePulse: AcousticPulse | null = null) {
  const [snapshot, setSnapshot] = useState<SensorSnapshot>(idleSnapshot);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioWorkletRef = useRef<AudioWorkletNode | null>(null);
  const rollingAudioRef = useRef<RollingSampleBuffer | null>(null);
  const captureRecorderRef = useRef(new CaptureRecorder());
  const streamingMatcherRef = useRef<StreamingPulseMatcher | null>(null);
  const animationRef = useRef<number | null>(null);
  const clockTimerRef = useRef<number | null>(null);
  const locationWatchRef = useRef<number | null>(null);
  const clockSyncRunRef = useRef(0);
  const motionActiveRef = useRef(false);
  const headingActiveRef = useRef(false);
  const motionMetadataRef = useRef<MotionSensorMetadata>(idleMotionMetadata);
  const serverClockExchangesRef = useRef<ClockExchange[]>([]);
  const peerClockExchangesRef = useRef<ClockExchange[]>([]);
  const clockAuthorityRef = useRef<ClockAuthority>("external");
  const clockModelRef = useRef<ClockModel | null>(null);
  const activePulseRef = useRef<AcousticPulse | null>(activePulse);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const lifecycleCleanupRef = useRef<(() => void) | null>(null);
  const motionRetryCleanupRef = useRef<(() => void) | null>(null);
  const captureGraphRef = useRef<CaptureGraph | null>(null);
  const waveSeriesRef = useRef(new WaveSeries(WAVE_HISTORY_MS));
  const captureSilentSincePerfMsRef = useRef<number | null>(null);
  const captureRebuildCountRef = useRef(0);
  const captureRebuildInFlightRef = useRef(false);
  // Resolved lazily (not in render) so localStorage is read once, on start.
  const captureModeRef = useRef<CaptureConstraintMode | null>(null);
  const lastStoredCaptureModeRef = useRef<CaptureConstraintMode | null>(null);
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

  // Recomputes the active clock model from whichever source currently wins:
  // identity when this device is the room reference, fresh data-channel peer
  // exchanges against the host, or the HTTP echo fallback.
  const refreshClockModel = useCallback(() => {
    const clock = selectClockModel({
      authority: clockAuthorityRef.current,
      peerExchanges: peerClockExchangesRef.current,
      serverExchanges: serverClockExchangesRef.current,
      nowPerfMs: performance.now(),
    });
    clockModelRef.current = clock;
    updateStreamingMatcherPulse(
      activePulseRef.current,
      audioContextRef.current,
      clock,
      streamingMatcherRef.current,
    );
    setSnapshot((current) => ({ ...current, clock }));
  }, []);

  // Feeds an NTP-style exchange measured over a realtime data channel
  // (peer <-> host) into the clock model. These exchanges have far lower
  // round trips than HTTP echo, so they dominate while fresh.
  const offerClockExchange = useCallback(
    (exchange: ClockExchange) => {
      // Deeper history than the HTTP path: probes are cheap on a data
      // channel, and more samples mean more low-round-trip picks for the
      // robust model plus a longer baseline for the drift fit.
      peerClockExchangesRef.current = retainClockExchanges(
        peerClockExchangesRef.current,
        exchange,
        { maxRoundTripMs: 350, maxSamples: 48 },
      );
      refreshClockModel();
    },
    [refreshClockModel],
  );

  // "self" marks this device as the room clock reference (the host).
  const setClockAuthority = useCallback(
    (authority: ClockAuthority) => {
      if (clockAuthorityRef.current === authority) {
        return;
      }
      clockAuthorityRef.current = authority;
      refreshClockModel();
    },
    [refreshClockModel],
  );

  // The capture context doubles as the chirp playback context: it was created
  // inside the user gesture, so iOS lets it keep running.
  const getAudioContext = useCallback(() => audioContextRef.current, []);

  // Live mic-envelope series on the host-clock timeline, for waveform
  // rendering and for sharing with peers over the data channel.
  const getWaveSeries = useCallback(() => waveSeriesRef.current, []);
  const getWaveChunk = useCallback(
    () => buildWaveChunk(waveSeriesRef.current, WAVE_BUCKET_MS, WAVE_CHUNK_BUCKETS),
    [],
  );

  // Switches the live capture pipeline (raw / processed / video-assisted) by
  // re-acquiring the stream. Call from a user gesture: the "video" mode can
  // show a camera permission prompt. reacquireCaptureStream is a hoisted
  // helper that only touches refs, so its identity is irrelevant here.
  const requestCaptureMode = useCallback((mode: CaptureConstraintMode) => {
    captureRebuildCountRef.current = 0;
    captureSilentSincePerfMsRef.current = null;
    lastStoredCaptureModeRef.current = mode;
    storeCaptureMode(mode);
    void reacquireCaptureStream(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    motionRetryCleanupRef.current?.();
    motionRetryCleanupRef.current = null;
    captureGraphRef.current = null;
    waveSeriesRef.current = new WaveSeries(WAVE_HISTORY_MS);
    captureSilentSincePerfMsRef.current = null;
    captureRebuildCountRef.current = 0;
    captureRebuildInFlightRef.current = false;
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
    serverClockExchangesRef.current = [];
    peerClockExchangesRef.current = [];
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

    captureModeRef.current ??= loadStoredCaptureMode();
    const startMode = captureModeRef.current;

    // Apple's AudioSession web API, where exposed, declares capture intent
    // before the stream exists; a no-op everywhere else.
    hintAudioSessionPlayAndRecord();

    // The microphone request must be the permission prompt issued inside the
    // raw tap-gesture stack, before ANY await: on iOS each permission prompt
    // consumes the gesture's user activation, and getUserMedia called without
    // activation is rejected WITHOUT ever showing a prompt. Motion permission
    // (which also consumes an activation) is requested on a later tap instead.
    const mediaStreamPromise = navigator.mediaDevices.getUserMedia(
      captureConstraintsFor(startMode),
    );

    // Clock sync is independent of the microphone: it must run even when
    // capture fails, both for the recovery paths and so a mic-less device
    // still shares the room timeline.
    void syncServerClock(serverClockExchangesRef, refreshClockModel);
    void warmServerClockSync(
      serverClockExchangesRef,
      () => clockSyncRunRef.current === syncRun,
      refreshClockModel,
    );
    if (clockTimerRef.current !== null) {
      window.clearInterval(clockTimerRef.current);
    }
    clockTimerRef.current = window.setInterval(
      () => void syncServerClock(serverClockExchangesRef, refreshClockModel),
      CLOCK_SYNC_INTERVAL_MS,
    );

    try {
      const stream = await mediaStreamPromise;
      mediaStreamRef.current = stream;
      const audioTrack = stream.getAudioTracks()[0] ?? null;
      const trackSettings = audioTrack?.getSettings?.() ?? null;

      // Canonical iOS ordering: the context is created AFTER the stream, so
      // WebKit instantiates it at the now-active capture route's hardware
      // rate (a pre-existing context at a mismatched rate reads silence).
      // The live capture session lets the context start without a fresh
      // gesture, and the lifecycle/tap backstops cover the stragglers.
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
      await resumeAudioContextIfNeeded(audioContext);
      setSnapshot((current) => ({
        ...current,
        captureProcessing: captureProcessingReportFor(trackSettings),
        captureMode: captureModeRef.current,
        trackMuted: audioTrack ? audioTrack.muted : null,
        audioContextState: audioContext.state,
      }));
      attachCaptureLifecycle(audioContext, audioTrack);
      // Opportunistic: succeeds on platforms where the activation survived
      // the mic prompt; iOS will reject it quietly.
      void requestMotionPermission();
      // Deterministic: the next tap anywhere re-requests inside a fresh
      // gesture. Once granted, iOS answers without showing the dialog again.
      motionRetryCleanupRef.current?.();
      motionRetryCleanupRef.current = armMotionPermissionRetry();
      await wireCaptureGraph(audioContext, stream);
      captureRebuildCountRef.current = 0;
      captureSilentSincePerfMsRef.current = null;
      startCaptureReadLoop();
    } catch {
      void audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = null;
      // A non-default capture mode that fails to start must not strand the
      // session: retry on the processed pipeline (permission, if granted,
      // carries over; if it was denied, this fails fast and marks the mic
      // blocked). This also un-bricks a stale persisted mode.
      if (startMode !== "processed") {
        captureModeRef.current = "processed";
        lastStoredCaptureModeRef.current = "processed";
        storeCaptureMode("processed");
        await reacquireCaptureStream("processed");
        // The read loop normally starts inside the try block; after a
        // fallback reacquire it must start here (it idles harmlessly if the
        // fallback also failed).
        startCaptureReadLoop();
      } else {
        setSnapshot((current) => ({
          ...current,
          mic: "blocked",
          audioContextState: null,
        }));
        return;
      }
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
    // attachCaptureLifecycle/startCaptureReadLoop are hoisted helpers that
    // only touch refs and the stable setSnapshot, so their per-render
    // identity is irrelevant here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshClockModel]);

  useEffect(() => stop, [stop]);
  useEffect(() => {
    trackPulse(activePulse);
  }, [activePulse, trackPulse]);

  return {
    snapshot,
    start,
    stop,
    trackPulse,
    offerClockExchange,
    setClockAuthority,
    getAudioContext,
    getWaveSeries,
    getWaveChunk,
    requestCaptureMode,
    startRecording,
    stopRecording,
  };

  function startRecording(recordingId: string) {
    captureRecorderRef.current.begin({
      recordingId,
      startedAtEpochMs: Date.now(),
    });
  }

  function stopRecording(): RecordedTake | null {
    return captureRecorderRef.current.end(Date.now());
  }

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

  function attachCaptureLifecycle(
    audioContext: AudioContext,
    audioTrack: MediaStreamTrack | null,
  ) {
    lifecycleCleanupRef.current?.();
    lifecycleCleanupRef.current = attachAudioLifecycle({
      audioContext,
      audioTrack,
      wakeLockRef,
      setSnapshot,
      resyncClock: () =>
        void syncServerClock(serverClockExchangesRef, refreshClockModel),
    });
  }

  // Builds (or rebuilds) the analyser/worklet/matcher graph for a context and
  // stream. Kept separate from start() so the silent-capture watchdog can
  // re-wire everything onto a fresh context without touching permissions.
  async function wireCaptureGraph(audioContext: AudioContext, stream: MediaStream) {
    audioWorkletRef.current?.disconnect();
    audioWorkletRef.current = null;
    captureGraphRef.current?.source.disconnect();
    captureGraphRef.current = null;

    const rollingAudio = new RollingSampleBuffer(ROLLING_AUDIO_HISTORY_SAMPLES);
    rollingAudioRef.current = rollingAudio;
    const streamingMatcher = new StreamingPulseMatcher({
      sampleRate: audioContext.sampleRate,
      historySamples: ROLLING_AUDIO_HISTORY_SAMPLES,
      // Room-scale chirps on phone transducers arrive weak; the consensus and
      // outlier layers in ranging absorb the occasional marginal detection.
      minScore: 0.45,
      minPeakRatio: 2,
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
      captureRecorderRef.current,
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
    captureGraphRef.current = {
      audioContext,
      analyser,
      source,
      samples: new Float32Array(analyser.fftSize),
    };
  }

  function startCaptureReadLoop() {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
    }

    const read = () => {
      const graph = captureGraphRef.current;
      if (!graph) {
        animationRef.current = requestAnimationFrame(read);
        return;
      }

      const { audioContext, analyser, samples } = graph;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        sum += sample * sample;
      }
      const micLevel = Math.sqrt(sum / samples.length);
      maybeRecoverSilentCapture(micLevel, audioContext);
      const timing = timestampCurrentAudioWindow(
        audioContext,
        samples,
        rollingAudioRef.current,
        clockModelRef.current,
      );
      const waveTimestampMs = timing.audioFrame?.hostEstimatedEpochMs;
      if (typeof waveTimestampMs === "number") {
        waveSeriesRef.current.appendSample(waveTimestampMs, micLevel);
      }
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
        audioContextState: audioContext.state,
        ...timing,
        voiceEvent: voiceEvent ?? current.voiceEvent,
        motion: motionActiveRef.current ? "active" : current.motion,
        heading: headingActiveRef.current ? "active" : current.heading,
      }));
      animationRef.current = requestAnimationFrame(read);
    };
    read();
  }

  function maybeRecoverSilentCapture(
    micLevel: number,
    audioContext: AudioContext,
  ) {
    if (micLevel >= HEALTHY_CAPTURE_RMS) {
      // Real signal observed: the pipeline works, so future interruptions
      // get a fresh recovery budget — and this mode is the device's
      // known-good capture path, worth remembering across reloads.
      captureRebuildCountRef.current = 0;
      captureSilentSincePerfMsRef.current = null;
      const liveMode = captureModeRef.current;
      if (liveMode && lastStoredCaptureModeRef.current !== liveMode) {
        lastStoredCaptureModeRef.current = liveMode;
        storeCaptureMode(liveMode);
      }
      return;
    }
    if (
      (audioContext.state as AudioContextRunState) !== "running" ||
      micLevel > QUIET_CAPTURE_RMS
    ) {
      captureSilentSincePerfMsRef.current = null;
      return;
    }

    const now = performance.now();
    captureSilentSincePerfMsRef.current ??= now;
    const requiredQuietMs =
      micLevel <= SILENT_CAPTURE_RMS
        ? SILENT_CAPTURE_REBUILD_MS
        : QUIET_CAPTURE_REBUILD_MS;
    if (now - captureSilentSincePerfMsRef.current < requiredQuietMs) {
      return;
    }

    captureSilentSincePerfMsRef.current = null;
    if (
      captureRebuildInFlightRef.current ||
      captureRebuildCountRef.current >= MAX_CAPTURE_RECOVERIES
    ) {
      return;
    }
    captureRebuildCountRef.current += 1;
    const attempt = captureRebuildCountRef.current;
    captureRebuildInFlightRef.current = true;
    // Recovery ladder: cheapest first. 1) fresh context, same stream;
    // 2) fresh stream too; 3+) fresh stream with default (processed)
    // constraints — a different iOS capture path entirely.
    const recovery =
      attempt <= 1
        ? rebuildCaptureGraph()
        : reacquireCaptureStream(
            attempt >= 3 ? "processed" : (captureModeRef.current ?? "processed"),
          );
    void recovery.finally(() => {
      captureRebuildInFlightRef.current = false;
    });
  }

  async function rebuildCaptureGraph() {
    const stream = mediaStreamRef.current;
    const audioTrack = stream?.getAudioTracks()[0] ?? null;
    if (!stream || !audioTrack || audioTrack.readyState !== "live") {
      return;
    }

    const previousContext = audioContextRef.current;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    // Default rate: WebKit picks the hardware rate of the now-active mic
    // route, which is the thing the original context may have guessed wrong.
    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    await resumeAudioContextIfNeeded(audioContext);
    attachCaptureLifecycle(audioContext, audioTrack);
    await wireCaptureGraph(audioContext, stream);
    setSnapshot((current) => ({
      ...current,
      sampleRate: audioContext.sampleRate,
      audioContextState: audioContext.state,
      captureRecoveries: captureRebuildCountRef.current,
    }));
    void previousContext?.close().catch(() => undefined);
  }

  // The production-grade iOS recovery: stop the silent tracks and ask for the
  // microphone again (permission persists, so no prompt), then rebuild the
  // whole graph on a context created AFTER the stream — the ordering WebKit
  // handles correctly.
  async function reacquireCaptureStream(mode: CaptureConstraintMode) {
    captureModeRef.current = mode;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    const stream = await navigator.mediaDevices
      .getUserMedia(captureConstraintsFor(mode))
      .catch(() => null);
    if (!stream) {
      setSnapshot((current) => ({ ...current, mic: "blocked" }));
      return;
    }

    mediaStreamRef.current = stream;
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    const previousContext = audioContextRef.current;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    await resumeAudioContextIfNeeded(audioContext);
    attachCaptureLifecycle(audioContext, audioTrack);
    await wireCaptureGraph(audioContext, stream);
    setSnapshot((current) => ({
      ...current,
      mic: "active",
      sampleRate: audioContext.sampleRate,
      audioContextState: audioContext.state,
      captureProcessing: captureProcessingReportFor(
        audioTrack?.getSettings?.() ?? null,
      ),
      captureMode: mode,
      trackMuted: audioTrack ? audioTrack.muted : null,
      captureRecoveries: captureRebuildCountRef.current,
    }));
    void previousContext?.close().catch(() => undefined);
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
    void resumeAudioContextIfNeeded(audioContext);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    void resumeAudioContextIfNeeded(audioContext);
    void requestWakeLock();
    resyncClock();
  };

  const onTrackEnded = () => {
    setSnapshot((current) => ({ ...current, mic: "blocked" }));
  };

  // iOS flags the track muted during interruptions (Siri, calls, route
  // changes) while the system mic indicator can stay lit; surfacing it lets
  // the UI explain the silence and the watchdog recover from it.
  const onTrackMute = () => {
    setSnapshot((current) => ({ ...current, trackMuted: true }));
  };
  const onTrackUnmute = () => {
    setSnapshot((current) => ({ ...current, trackMuted: false }));
    resyncClock();
  };

  // Backstop for contexts that ended up suspended outside a gesture (e.g.
  // the sample-rate-mismatch recreation): any subsequent tap revives them.
  const onPointerDown = () => {
    void resumeAudioContextIfNeeded(audioContext);
  };

  audioContext.addEventListener("statechange", onAudioStateChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("pointerdown", onPointerDown);
  audioTrack?.addEventListener("ended", onTrackEnded);
  audioTrack?.addEventListener("mute", onTrackMute);
  audioTrack?.addEventListener("unmute", onTrackUnmute);
  void requestWakeLock();

  return () => {
    audioContext.removeEventListener("statechange", onAudioStateChange);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("pointerdown", onPointerDown);
    audioTrack?.removeEventListener("ended", onTrackEnded);
    audioTrack?.removeEventListener("mute", onTrackMute);
    audioTrack?.removeEventListener("unmute", onTrackUnmute);
  };
}

function captureConstraintsFor(
  mode: CaptureConstraintMode,
): MediaStreamConstraints {
  // "raw" disables voice processing for acoustic work; "processed" is the
  // browser default path, which on iOS is a different (and sometimes the
  // only working) capture pipeline. "video" adds a minimal camera request:
  // iOS selects and beamforms the microphone differently while a camera
  // captures, which is worth testing when audio-only capture is filtered.
  const rawAudio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (mode === "video") {
    return {
      audio: rawAudio,
      video: {
        facingMode: "user",
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 15 },
      },
    };
  }
  return { audio: mode === "raw" ? rawAudio : true };
}

// Verify what the browser actually granted: iOS Safari treats audio
// constraints as best-effort and active voice processing attenuates the
// near-ultrasound chirp band.
function captureProcessingReportFor(
  trackSettings: MediaTrackSettings | null,
): CaptureProcessingReport {
  return {
    echoCancellation: booleanOrNull(trackSettings?.echoCancellation),
    noiseSuppression: booleanOrNull(trackSettings?.noiseSuppression),
    autoGainControl: booleanOrNull(trackSettings?.autoGainControl),
    rawCaptureVerified:
      trackSettings?.echoCancellation === false &&
      trackSettings?.noiseSuppression === false &&
      trackSettings?.autoGainControl === false,
  };
}

function booleanOrNull(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

// Apple's AudioSession web API (W3C Audio Session, shipped progressively in
// WebKit): declaring "play-and-record" before capture tells iOS to configure
// the audio session for simultaneous capture and playback instead of
// guessing from usage. Undefined on other engines.
function hintAudioSessionPlayAndRecord() {
  const session = (
    navigator as Navigator & { audioSession?: { type: string } }
  ).audioSession;
  if (!session) {
    return;
  }
  try {
    session.type = "play-and-record";
  } catch {
    // Older enum sets: leave the session in automatic mode.
  }
}

// iOS reports a non-standard "interrupted" state after audio route changes,
// phone calls, and Siri — and getUserMedia itself triggers a route change.
// Treat anything that is not running (and not closed) as resumable; only
// resuming on "suspended" leaves interrupted contexts silently dead.
async function resumeAudioContextIfNeeded(context: AudioContext) {
  const state = context.state as AudioContextRunState;
  if (state === "running" || state === "closed") {
    return;
  }
  await context.resume().catch(() => undefined);
}

function armMotionPermissionRetry() {
  const request = () => {
    void requestMotionPermission();
  };
  document.addEventListener("pointerdown", request, { once: true });
  return () => document.removeEventListener("pointerdown", request);
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

async function syncServerClock(
  exchangesRef: MutableRefObject<ClockExchange[]>,
  onExchangesUpdated: () => void,
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
    exchangesRef.current = retainClockExchanges(exchangesRef.current, exchange);
    onExchangesUpdated();
    return true;
  } catch {
    return false;
  }
}

async function warmServerClockSync(
  exchangesRef: MutableRefObject<ClockExchange[]>,
  isCurrentRun: () => boolean,
  onExchangesUpdated: () => void,
) {
  for (let index = 0; index < CLOCK_SYNC_WARMUP_COUNT; index += 1) {
    await wait(CLOCK_SYNC_WARMUP_SPACING_MS);
    if (!isCurrentRun()) {
      return;
    }
    await syncServerClock(exchangesRef, onExchangesUpdated);
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
  // Center the cut half a window behind the trigger: the trigger sample is
  // the newest one captured, so a centered window would be half zeros. The
  // shift is identical in device-local time on every device, so it cancels
  // in cross-device differences. 16 kHz keeps speech's full TDOA band and
  // halves the GCC quantization step versus 8 kHz.
  const audioSnippet = captureAudioSnippet({
    samples: audioWindow.samples,
    sampleRate: audioWindow.sampleRate,
    startSampleIndex: audioWindow.startSampleIndex,
    centerSampleIndex:
      event.sampleIndex - Math.round(0.12 * audioWindow.sampleRate),
    windowMs: 240,
    targetSampleRate: 16_000,
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
  recorder: CaptureRecorder | null,
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
      recorder?.append(
        samples,
        event.data.startSampleIndex,
        event.data.sampleRate ?? audioContext.sampleRate,
      );
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
    // A sparse clock model reports Infinity, which JSON serializes to null
    // and the server then rejects the whole audio frame — taking this device
    // out of the chirp rotation invisibly. Clamp to a finite, honest
    // worst-case bound instead so the frame survives transport.
    clockUncertaintyMs: finiteClockMs(projected.uncertaintyMs),
    clockQuality: clock.quality,
    clockMaxErrorMs: finiteClockMs(projected.maxErrorMs),
    clockBestRoundTripMs: finiteClockMs(clock.bestRoundTripMs),
    clockJitterMs: finiteClockMs(clock.jitterMs),
    clockSamplesUsed: clock.samplesUsed,
    clockOutliersRejected: clock.outliersRejected,
    clockOffsetStabilityMs: finiteClockMs(clock.offsetStabilityMs),
  });
}

const MAX_REPORTED_CLOCK_ERROR_MS = 9_999;

function finiteClockMs(value: number) {
  return Number.isFinite(value)
    ? Math.min(value, MAX_REPORTED_CLOCK_ERROR_MS)
    : MAX_REPORTED_CLOCK_ERROR_MS;
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
