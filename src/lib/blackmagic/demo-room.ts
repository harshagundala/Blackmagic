import type { PairwiseMeasurement } from "@/lib/calibration/session";

export type DemoPhone = {
  id: string;
  role: "host" | "peer";
};

export const initialPhones: DemoPhone[] = [
  { id: "host", role: "host" },
  { id: "north", role: "peer" },
  { id: "east", role: "peer" },
  { id: "southwest", role: "peer" },
];

export const demoMeasurements: PairwiseMeasurement[] = [
  { from: "host", to: "north", meters: 1.85, confidence: 0.82 },
  { from: "host", to: "north", meters: 1.76, confidence: 0.91 },
  { from: "host", to: "north", meters: 1.8, confidence: 0.88 },
  { from: "host", to: "east", meters: 2.16, confidence: 0.8 },
  { from: "host", to: "east", meters: 2.08, confidence: 0.86 },
  { from: "host", to: "east", meters: 2.12, confidence: 0.84 },
  { from: "host", to: "southwest", meters: 1.48, confidence: 0.78 },
  { from: "host", to: "southwest", meters: 1.54, confidence: 0.83 },
  { from: "host", to: "southwest", meters: 1.5, confidence: 0.81 },
  { from: "north", to: "east", meters: 2.72, confidence: 0.76 },
  { from: "north", to: "east", meters: 2.66, confidence: 0.8 },
  { from: "north", to: "east", meters: 2.7, confidence: 0.79 },
  { from: "north", to: "southwest", meters: 2.42, confidence: 0.72 },
  { from: "north", to: "southwest", meters: 2.34, confidence: 0.79 },
  { from: "north", to: "southwest", meters: 2.38, confidence: 0.76 },
  { from: "east", to: "southwest", meters: 3.04, confidence: 0.7 },
  { from: "east", to: "southwest", meters: 2.96, confidence: 0.78 },
  { from: "east", to: "southwest", meters: 3, confidence: 0.76 },
];

export function qrCells(seed: string) {
  const normalized = seed.padEnd(6, "0");
  const cells: boolean[] = [];
  let value = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    value = (value * 31 + normalized.charCodeAt(index)) >>> 0;
  }

  for (let index = 0; index < 49; index += 1) {
    const isFinder =
      (index < 16 && index % 7 < 4) ||
      (index % 7 > 4 && Math.floor(index / 7) < 4) ||
      (index % 7 < 3 && Math.floor(index / 7) > 4);
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    cells.push(isFinder || (value & 1) === 1);
  }

  return cells;
}
