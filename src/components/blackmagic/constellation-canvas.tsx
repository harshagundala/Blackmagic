"use client";

import type { PairwiseDistance, PhonePoint, ConstellationLayout } from "@/lib/positioning/layout";
import type { DemoPhone } from "@/lib/blackmagic/demo-room";

type ConstellationCanvasProps = {
  activeDistance: PairwiseDistance | null;
  layout: ConstellationLayout;
  phones: DemoPhone[];
  phase: "idle" | "listening" | "syncing" | "calibrating" | "ready";
  progress: number;
  sensorLevel: number;
  tick: number;
};

const canvasSize = 620;
const center = canvasSize / 2;

export function ConstellationCanvas({
  activeDistance,
  layout,
  phones,
  phase,
  progress,
  sensorLevel,
  tick,
}: ConstellationCanvasProps) {
  const scale = 78;
  const fallbackRadius = 126 + Math.sin(tick * 0.7) * 8;
  const points = phones.map((phone, index) => {
    const solved = layout.points[phone.id];
    const angle = -Math.PI / 2 + index * ((Math.PI * 2) / phones.length);
    const fallback = {
      x: Math.cos(angle) * fallbackRadius,
      y: Math.sin(angle) * fallbackRadius,
    };
    const point = solved
      ? { x: center + solved.x * scale, y: center + solved.y * scale }
      : { x: center + fallback.x, y: center + fallback.y };

    return {
      ...phone,
      point,
    };
  });
  const byId = new Map(points.map((phone) => [phone.id, phone]));
  const activeFrom = activeDistance ? byId.get(activeDistance.from)?.point : null;
  const activeTo = activeDistance ? byId.get(activeDistance.to)?.point : null;
  const sweepOpacity = phase === "idle" ? 0.22 : 0.62;
  const audioPulse = Math.min(1, Math.max(0.08, sensorLevel * 18));

  return (
    <div
      className="relative aspect-square w-[min(88vw,76dvh)] max-w-[720px]"
      style={{ animation: "rise 600ms ease both" }}
    >
      <svg
        aria-hidden
        className="absolute inset-0 h-full w-full overflow-visible"
        viewBox={`0 0 ${canvasSize} ${canvasSize}`}
      >
        <defs>
          <radialGradient id="bm-center" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="56%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#d7efff" stopOpacity="0.36" />
          </radialGradient>
          <linearGradient id="bm-ring" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#020617" stopOpacity="0.04" />
            <stop offset="50%" stopColor="#007aff" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#33d6ff" stopOpacity="0.05" />
          </linearGradient>
          <filter id="bm-blue-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="10" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle cx={center} cy={center} fill="url(#bm-center)" r="284" />
        {[112, 178, 244].map((radius, index) => (
          <circle
            cx={center}
            cy={center}
            fill="none"
            key={radius}
            opacity={0.28 + index * 0.12}
            r={radius + audioPulse * 16}
            stroke="url(#bm-ring)"
            strokeDasharray={`${2 + index} ${14 - index * 2}`}
            strokeWidth="1.4"
          />
        ))}
        <g
          opacity={sweepOpacity}
          style={{
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: phase === "idle" ? undefined : "sweep 9s linear infinite",
          }}
        >
          <path
            d={`M ${center} ${center} L ${center + 245} ${center - 18} A 246 246 0 0 1 ${center + 212} ${center + 123} Z`}
            fill="rgba(0,122,255,0.08)"
          />
        </g>

        {layout && (
          <g opacity={0.28 + progress * 0.42}>
            {Object.entries(layout.points).flatMap(([from, fromPoint]) =>
              Object.entries(layout.points)
                .filter(([to]) => from < to)
                .map(([to, toPoint]) => (
                  <line
                    key={`${from}-${to}`}
                    stroke="rgba(0,122,255,0.25)"
                    strokeDasharray="4 12"
                    strokeLinecap="round"
                    strokeWidth="1.2"
                    x1={center + fromPoint.x * scale}
                    x2={center + toPoint.x * scale}
                    y1={center + fromPoint.y * scale}
                    y2={center + toPoint.y * scale}
                  />
                )),
            )}
          </g>
        )}

        {activeFrom && activeTo ? (
          <line
            filter="url(#bm-blue-glow)"
            opacity="0.92"
            stroke="#007aff"
            strokeLinecap="round"
            strokeWidth="3"
            x1={activeFrom.x}
            x2={activeTo.x}
            y1={activeFrom.y}
            y2={activeTo.y}
          />
        ) : null}

        {points.map((phone, index) => (
          <PhoneNode
            index={index}
            key={phone.id}
            point={phone.point}
            role={phone.role}
            signal={phone.role === "host" ? 1 : 0.62 + progress * 0.38}
          />
        ))}
      </svg>
    </div>
  );
}

function PhoneNode({
  index,
  point,
  role,
  signal,
}: {
  index: number;
  point: PhonePoint;
  role: DemoPhone["role"];
  signal: number;
}) {
  const isHost = role === "host";
  const fill = isHost ? "#05070a" : "#007aff";

  return (
    <g
      filter={isHost ? undefined : "url(#bm-blue-glow)"}
      style={{
        transition: "transform 720ms cubic-bezier(.2,.8,.2,1)",
        transform: `translate(${point.x}px, ${point.y}px)`,
      }}
    >
      <circle
        fill={isHost ? "rgba(5,7,10,0.06)" : "rgba(0,122,255,0.1)"}
        r={42 + signal * 14}
        style={{
          animation: `breathe ${2.8 + index * 0.25}s ease-in-out infinite`,
        }}
      />
      <rect
        fill={fill}
        height={isHost ? 38 : 34}
        rx={isHost ? 13 : 12}
        stroke={isHost ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.82)"}
        strokeWidth="2"
        transform={`translate(${isHost ? -15 : -13}, ${isHost ? -19 : -17})`}
        width={isHost ? 30 : 26}
      />
      <circle cx="0" cy={isHost ? 11 : 10} fill="rgba(255,255,255,0.72)" r="1.8" />
    </g>
  );
}
