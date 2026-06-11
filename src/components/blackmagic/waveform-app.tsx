"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomSession } from "@/hooks/use-room-session";
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
  RealtimeSensorFrameMessage,
} from "@/lib/realtime/contracts";
import { roomStatePollingIntervalMs } from "@/lib/session/polling";
import type { DeviceTimeSyncState } from "@/lib/session/timing-health";
import {
  ReconciliationEngine,
  type ReconciliationSnapshot,
} from "@/lib/reconciliation/engine";
import type { VoiceActivityEvent } from "@/lib/session/audio-events";

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

  const realtime = useWebRtcRoom({
    active: phase === "listening",
    deviceId,
    roomState,
    snapshot: sensors.snapshot,
    getWaveChunk: sensors.getWaveChunk,
    getVoiceEvent: useCallback(() => snapshotRef.current.voiceEvent, []),
    getReconciliationState: useCallback(
      () => reconciliationMessageRef.current,
      [],
    ),
    onVoiceEvent: useCallback(
      (event: VoiceActivityEvent, fromDeviceId: string) => {
        if (isHostRef.current) {
          hostEngine().ingestVoiceEvent(fromDeviceId, event);
        }
      },
      [hostEngine],
    ),
    onReconciliationState: useCallback(
      (state: RealtimeReconciliationStateMessage) => {
        if (!isHostRef.current) {
          setReconciliation(state);
        }
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

  // Host: a peer's motion stability gates its acoustic evidence — a phone
  // that moved invalidates the distances it took part in.
  useEffect(() => {
    if (!isHost) {
      return;
    }
    const engine = hostEngine();
    for (const frame of realtime.peerFrames) {
      if (
        frame.motionStability !== null &&
        frame.hostEstimatedEpochMs !== null
      ) {
        engine.noteMotion(
          frame.fromDeviceId,
          frame.motionStability,
          frame.hostEstimatedEpochMs,
        );
      }
    }
  }, [hostEngine, isHost, realtime.peerFrames]);

  // Host: feed its own voice events into the engine as they fire.
  const ownVoiceEvent = sensors.snapshot.voiceEvent;
  useEffect(() => {
    if (isHost && ownVoiceEvent) {
      hostEngine().ingestVoiceEvent(deviceId, ownVoiceEvent);
    }
  }, [deviceId, hostEngine, isHost, ownVoiceEvent]);

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
  }, [deviceId, hostEngine, isHost, phase]);

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
                    onClick={() =>
                      sensors.requestCaptureMode(
                        nextCaptureMode(sensors.snapshot.captureMode),
                      )
                    }
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
            <ReconciliationPanel
              nowHostMs={nowHostMs}
              selfDeviceId={deviceId}
              state={reconciliation}
            />
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
  return `${syncLabel} · lvl ${level}${age}`;
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
      meters: range.meters,
      uncertaintyMeters: range.uncertaintyMeters,
      coverage: range.coverage,
      confidence: range.confidence,
      samplesUsed: range.samplesUsed,
    })),
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
      drawReconciliationMap(canvas, points, talker, selfDeviceId, stale);
    }
  }, [points, selfDeviceId, stale, talker]);

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
                  {describeRangeState(range.confidence, range.coverage)}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-black/35">
          say something — distances appear as sound crosses the room
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

  // Faint range lines between every pair ground the dots visually.
  context.strokeStyle = `rgba(6,17,46,${0.1 * alpha})`;
  context.lineWidth = 1;
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = toCanvas(entries[i][1]);
      const b = toCanvas(entries[j][1]);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
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
