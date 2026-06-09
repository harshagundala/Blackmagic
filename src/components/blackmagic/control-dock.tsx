"use client";

import type { ReactNode } from "react";

export type DockControl = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  selected?: boolean;
};

export function ControlDock({ controls }: { controls: DockControl[] }) {
  return (
    <nav
      aria-label="Blackmagic controls"
      className="mb-1 flex items-center gap-2 rounded-full border border-black/10 bg-white/72 p-2 shadow-[0_24px_80px_rgba(3,10,28,0.16)] backdrop-blur-2xl"
    >
      {controls.map((control) => (
        <button
          aria-label={control.label}
          className={`grid h-12 w-12 place-items-center rounded-full border transition duration-300 focus:outline-none focus:ring-4 focus:ring-[#007aff]/20 ${
            control.selected
              ? "border-[#007aff]/30 bg-[#06070a] text-white shadow-[0_10px_28px_rgba(0,122,255,0.28)]"
              : "border-black/8 bg-white/76 text-[#06070a] hover:border-[#007aff]/30 hover:text-[#007aff]"
          }`}
          key={control.label}
          onClick={control.onClick}
          title={control.label}
          type="button"
        >
          {control.icon}
        </button>
      ))}
    </nav>
  );
}
