"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomSession } from "@/hooks/use-room-session";
import { useSensorSuite, type SensorSnapshot } from "@/hooks/use-sensor-suite";
import { useWebRtcRoom } from "@/hooks/use-webrtc-room";
import { WaveSeries } from "@/lib/waveform/wave-series";
import { projectClockModel } from "@/lib/timing/clock-sync";
import { roomStatePollingIntervalMs } from "@/lib/session/polling";
import type { DeviceTimeSyncState } from "@/lib/session/timing-health";

type Phase = "arriving" | "listening";

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
  });
  const sensors = useSensorSuite();
  const offerClockExchange = sensors.offerClockExchange;
  const setClockAuthority = sensors.setClockAuthority;
  const snapshotRef = useRef(sensors.snapshot);
  const peerSeriesRef = useRef(new Map<string, WaveSeries>());
  const canvasesRef = useRef(new Map<string, HTMLCanvasElement>());

  const realtime = useWebRtcRoom({
    active: phase === "listening",
    deviceId,
    roomState,
    snapshot: sensors.snapshot,
    getWaveChunk: sensors.getWaveChunk,
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
      }
    }
  }, [realtime.peerFrames, roomState?.devices]);

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
  const isHost = roomState?.hostDeviceId === deviceId;
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
          {sensors.snapshot.mic === "blocked" ? (
            <span className="text-[#b45309]">mic off — tap to enable</span>
          ) : sensors.snapshot.trackMuted ? (
            <span className="text-[#b45309]">mic muted by ios</span>
          ) : sensors.snapshot.audioContextState &&
            sensors.snapshot.audioContextState !== "running" ? (
            <span className="text-[#b45309]">audio paused — tap</span>
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
                    {describeDeviceSync(
                      syncByDevice.get(device.deviceId) ?? null,
                      device.role === "host",
                    )}
                  </span>
                </div>
                <canvas
                  className="block h-[72px] w-full"
                  ref={registerCanvas(device.deviceId)}
                />
                {self ? (
                  <div className="px-4 pb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-black/30">
                    {captureDiagnostics(sensors.snapshot)}
                  </div>
                ) : null}
              </section>
            );
          })}
          {devices.length <= 1 ? (
            <p className="px-1 pt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-black/35">
              open this url on another phone
            </p>
          ) : null}
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
  const mode = snapshot.captureProcessing
    ? snapshot.captureProcessing.rawCaptureVerified
      ? "raw"
      : snapshot.captureMode === "processed"
        ? "processed"
        : "filtered"
    : (snapshot.captureMode ?? "—");
  const level =
    snapshot.micLevel > 0 ? snapshot.micLevel.toExponential(1) : "0";
  const recoveries =
    snapshot.captureRecoveries > 0 ? ` · fix ${snapshot.captureRecoveries}` : "";
  const muted = snapshot.trackMuted ? " · muted" : "";
  return `${rate} ${contextState} · ${mode} · lvl ${level}${recoveries}${muted}`;
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
