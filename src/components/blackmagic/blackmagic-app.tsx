"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSensorSuite } from "@/hooks/use-sensor-suite";
import type { SessionRole } from "@/lib/session/registry";

type Phase = "arriving" | "waiting" | "listening";

type SessionClaimResponse = {
  role: SessionRole;
  sessionKey: string;
};

export function BlackmagicApp() {
  const sensors = useSensorSuite();
  const [phase, setPhase] = useState<Phase>("arriving");
  const [role, setRole] = useState<SessionRole | null>(null);
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);

  useEffect(() => {
    let cancelled = false;

    async function claim() {
      const response = await fetch("/api/session/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId,
          url: window.location.href,
        }),
      });
      const data = (await response.json()) as SessionClaimResponse;
      if (!cancelled) {
        setRole(data.role);
        setPhase("waiting");
      }
    }

    void claim();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const begin = useCallback(async () => {
    if (phase === "listening") {
      return;
    }

    setPhase("listening");
    await sensors.start();
  }, [phase, sensors]);

  const label = phase === "arriving" ? "" : role === "host" ? "host" : "nearby";
  const pulse = phase === "listening" ? Math.min(1, Math.max(0.18, sensors.snapshot.micLevel * 24)) : 0.28;

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
            {label}
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

function getOrCreateDeviceId() {
  if (typeof window === "undefined") {
    return "server";
  }

  const key = "blackmagic.device";
  const existing = window.localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  window.localStorage.setItem(key, next);
  return next;
}
