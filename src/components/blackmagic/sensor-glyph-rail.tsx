"use client";

import { Compass, MapPin, Mic2, Move3D } from "lucide-react";
import type { SensorSnapshot } from "@/hooks/use-sensor-suite";

const glyphs = [
  { key: "mic", icon: Mic2 },
  { key: "motion", icon: Move3D },
  { key: "heading", icon: Compass },
  { key: "location", icon: MapPin },
] as const;

export function SensorGlyphRail({ snapshot }: { snapshot: SensorSnapshot }) {
  return (
    <div className="absolute left-1/2 top-[calc(8dvh+34px)] flex -translate-x-1/2 items-center gap-2">
      {glyphs.map(({ key, icon: Icon }) => {
        const active = snapshot[key] === "active";
        return (
          <span
            aria-hidden
            className={`grid h-7 w-7 place-items-center rounded-full border transition duration-500 ${
              active
                ? "border-[#007aff]/30 bg-[#007aff]/10 text-[#007aff]"
                : "border-black/8 bg-white/52 text-black/24"
            }`}
            key={key}
          >
            <Icon size={13} strokeWidth={1.8} />
          </span>
        );
      })}
    </div>
  );
}
