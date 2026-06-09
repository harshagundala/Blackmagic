"use client";

import { Radio, ScanLine, Share2, Sparkles, Square, Waves } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  createPairwiseCalibrationPlan,
  summarizePairwiseMeasurements,
  type PairwiseMeasurement,
} from "@/lib/calibration/session";
import { estimateConstellation, type PairwiseDistance } from "@/lib/positioning/layout";
import { demoMeasurements, initialPhones, qrCells } from "@/lib/blackmagic/demo-room";
import { useSensorSuite } from "@/hooks/use-sensor-suite";
import { ConstellationCanvas } from "./constellation-canvas";
import { ControlDock } from "./control-dock";
import { SensorGlyphRail } from "./sensor-glyph-rail";

type AppPhase = "idle" | "listening" | "syncing" | "calibrating" | "ready";

const statusCopy: Record<AppPhase, string> = {
  idle: "tap",
  listening: "listening",
  syncing: "syncing",
  calibrating: "calibrating",
  ready: "locked",
};

export function BlackmagicApp() {
  const [phase, setPhase] = useState<AppPhase>("idle");
  const reactId = useId();
  const roomId = useMemo(() => stableRoomId(reactId), [reactId]);
  const [showInvite, setShowInvite] = useState(true);
  const [measurements, setMeasurements] = useState<PairwiseMeasurement[]>([]);
  const [activeDistance, setActiveDistance] = useState<PairwiseDistance | null>(null);
  const [tick, setTick] = useState(0);
  const sensors = useSensorSuite();

  const participantIds = useMemo(() => initialPhones.map((phone) => phone.id), []);
  const calibrationPlan = useMemo(
    () =>
      createPairwiseCalibrationPlan(participantIds, {
        chirpsPerPair: 3,
        slotDurationMs: 360,
        guardMs: 140,
      }),
    [participantIds],
  );
  const ranges = useMemo(() => summarizePairwiseMeasurements(measurements), [measurements]);
  const layout = useMemo(
    () =>
      estimateConstellation(participantIds, ranges, {
        anchorId: "host",
        iterations: 1_000,
      }),
    [participantIds, ranges],
  );

  const calibrate = useCallback(() => {
    setMeasurements([]);
    setActiveDistance(null);
    setPhase("calibrating");

    demoMeasurements.forEach((measurement, index) => {
      window.setTimeout(() => {
        setMeasurements((current) => [...current, measurement]);
        setActiveDistance({
          from: measurement.from,
          to: measurement.to,
          meters: measurement.meters,
          weight: measurement.confidence,
        });
        if (index === demoMeasurements.length - 1) {
          window.setTimeout(() => {
            setPhase("ready");
            setActiveDistance(null);
          }, 420);
        }
      }, index * 420);
    });
  }, []);

  const begin = useCallback(async () => {
    setPhase("listening");
    await sensors.start();
    setPhase("syncing");
    window.setTimeout(calibrate, 520);
  }, [calibrate, sensors]);

  const stop = useCallback(() => {
    sensors.stop();
    setPhase("idle");
    setMeasurements([]);
    setActiveDistance(null);
  }, [sensors]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_200);
    return () => window.clearInterval(timer);
  }, []);

  const qr = useMemo(() => qrCells(roomId), [roomId]);
  const progress = calibrationPlan.slots.length
    ? Math.min(1, measurements.length / calibrationPlan.slots.length)
    : 0;

  return (
    <main className="relative min-h-dvh overflow-hidden bg-white text-[#06070a]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[40dvh] bg-[radial-gradient(circle_at_50%_0%,rgba(2,8,23,0.16),transparent_58%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[46dvh] bg-[linear-gradient(180deg,transparent,rgba(0,122,255,0.08))]" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[min(76vw,76vh)] w-[min(76vw,76vh)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(0,122,255,0.12),rgba(255,255,255,0)_62%)] blur-2xl" />

      <div className="relative grid min-h-dvh grid-rows-[1fr_auto] px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] sm:px-8 lg:grid-cols-[104px_1fr_104px] lg:grid-rows-1 lg:px-8 lg:py-8">
        <aside
          className={`absolute right-4 top-[max(18px,env(safe-area-inset-top))] z-20 origin-top-right transition duration-500 lg:static lg:col-start-1 lg:flex lg:h-full lg:origin-center lg:flex-col lg:items-center lg:justify-center lg:border-r lg:border-black/5 ${
            showInvite ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"
          }`}
          aria-hidden={!showInvite}
        >
          <span className="mb-24 hidden h-8 w-8 rounded-full bg-[#05070a] shadow-[0_12px_30px_rgba(3,10,28,0.26)] lg:block" />
          <div className="rounded-[28px] border border-black/10 bg-white/70 p-3 shadow-[0_22px_70px_rgba(3,10,28,0.16)] backdrop-blur-2xl">
            <div className="grid grid-cols-7 gap-1 rounded-[18px] bg-white p-2">
              {qr.map((cell, index) => (
                <span
                  className={`h-2 w-2 rounded-[2px] ${cell ? "bg-[#05070a]" : "bg-transparent"}`}
                  key={`${roomId}-${index}`}
                />
              ))}
            </div>
            <div className="mx-auto mt-3 flex w-12 items-center justify-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[#05070a]" />
              <span className="h-1.5 w-1.5 rounded-full bg-[#007aff]" />
              <span className="h-1.5 w-1.5 rounded-full bg-[#33d6ff]" />
            </div>
          </div>
          <div className="mt-8 hidden flex-col items-center gap-5 lg:flex">
            {initialPhones.map((phone) => (
              <span
                className={`h-4 w-4 rounded-full shadow-[0_10px_24px_rgba(0,122,255,0.28)] ${
                  phone.role === "host" ? "bg-[#05070a]" : "bg-[#007aff]"
                }`}
                key={phone.id}
              />
            ))}
            <span className="h-4 w-4 rounded-full border border-black/15 bg-white" />
          </div>
        </aside>

        <section className="relative flex min-h-0 items-center justify-center lg:col-start-2">
          <ConstellationCanvas
            activeDistance={activeDistance}
            layout={layout}
            phones={initialPhones}
            phase={phase}
            progress={progress}
            sensorLevel={sensors.snapshot.micLevel}
            tick={tick}
          />

          <div className="absolute left-1/2 top-[8dvh] -translate-x-1/2 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-black/42">
              {statusCopy[phase]}
            </p>
          </div>

          <SensorGlyphRail snapshot={sensors.snapshot} />
        </section>

        <div className="fixed inset-x-0 bottom-[max(16px,env(safe-area-inset-bottom))] z-30 flex justify-center px-4">
          <ControlDock
            controls={[
              {
                icon: <Radio aria-hidden size={20} strokeWidth={1.9} />,
                label: "Start sensors",
                onClick: begin,
                selected: phase !== "idle",
              },
              {
                icon: <Share2 aria-hidden size={20} strokeWidth={1.9} />,
                label: "Show invite",
                onClick: () => setShowInvite((value) => !value),
                selected: showInvite,
              },
              {
                icon: <ScanLine aria-hidden size={20} strokeWidth={1.9} />,
                label: "Calibrate",
                onClick: calibrate,
                selected: phase === "calibrating",
              },
              {
                icon: phase === "ready" ? (
                  <Sparkles aria-hidden size={20} strokeWidth={1.9} />
                ) : (
                  <Waves aria-hidden size={20} strokeWidth={1.9} />
                ),
                label: "Signal",
                onClick: calibrate,
                selected: phase === "ready",
              },
              {
                icon: <Square aria-hidden size={18} strokeWidth={2.2} />,
                label: "Stop",
                onClick: stop,
              },
            ]}
          />
        </div>
      </div>
    </main>
  );
}

function stableRoomId(seed: string) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  let value = 0;
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 33 + seed.charCodeAt(index)) >>> 0;
  }

  for (let index = 0; index < 6; index += 1) {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    code += alphabet[value % alphabet.length];
  }
  return code;
}
