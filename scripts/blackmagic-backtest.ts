#!/usr/bin/env tsx
// Backtest the chirp-ranging pipeline against an uploaded ground-truth take,
// so detection and ranging changes can be validated offline instead of
// burning a physical two-phone test on every iteration.
//
// Usage:
//   npx tsx scripts/blackmagic-backtest.ts --list
//   npx tsx scripts/blackmagic-backtest.ts take-ca14d19a [--expected 0.1]
//   npx tsx scripts/blackmagic-backtest.ts /path/to/dir-with-wav-and-json
//
// Blob access needs BLOB_READ_WRITE_TOKEN in the environment (e.g. from
// `vercel env pull`); local directories work without it.
//
// The script discovers each device's chirp train empirically (current and
// legacy lane/duration profiles), replays the REAL detection chain
// (createMatchedToneObservation with production thresholds), then feeds the
// REAL ranging math (deriveAcousticRanges) incrementally the way the edge
// pipeline does — reporting detection rate, time to first range, and the
// range trajectory against the expected distance.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createMatchedToneObservation } from "../src/lib/calibration/pulse";
import { deriveAcousticRanges } from "../src/lib/session/ranging";
import type {
  AcousticObservation,
  AcousticPulse,
  RoomDevice,
} from "../src/lib/session/registry";

const PRODUCTION_MIN_SCORE = 0.05;
const PRODUCTION_MIN_PEAK_RATIO = 4;
// Profiles a take may contain, newest first (older takes ran older builds).
const EMISSION_PROFILES = [
  { label: "ultrasonic-200ms", durationMs: 200, bands: [
    { frequencyHz: 16_300, endFrequencyHz: 16_900 },
    { frequencyHz: 16_900, endFrequencyHz: 17_500 },
    { frequencyHz: 17_500, endFrequencyHz: 18_100 },
    { frequencyHz: 18_100, endFrequencyHz: 18_700 },
  ]},
  { label: "legacy-ultrasonic-200ms", durationMs: 200, bands: [
    { frequencyHz: 15_500, endFrequencyHz: 16_250 },
    { frequencyHz: 16_250, endFrequencyHz: 17_000 },
    { frequencyHz: 17_000, endFrequencyHz: 17_750 },
    { frequencyHz: 17_750, endFrequencyHz: 18_400 },
  ]},
  { label: "legacy-audible-80ms", durationMs: 80, bands: [
    { frequencyHz: 8_500, endFrequencyHz: 9_500 },
    { frequencyHz: 9_500, endFrequencyHz: 10_500 },
    { frequencyHz: 10_500, endFrequencyHz: 11_500 },
    { frequencyHz: 11_500, endFrequencyHz: 11_950 },
  ]},
];

type TakeDevice = {
  deviceId: string;
  role: string;
  samples: Float32Array;
  sampleRate: number;
  firstSampleIndex: number;
  startedAtEpochMs: number;
  clockOffsetMs: number;
  clockUncertaintyMs: number;
};

type Train = {
  emitterId: string;
  // The recording the chirp times are measured in (not necessarily the
  // emitter: at close range every recording captures every train).
  referenceDeviceId: string;
  band: { frequencyHz: number; endFrequencyHz: number };
  durationMs: number;
  profile: string;
  timesSeconds: number[];
  meanOwnScore: number;
};

void main();

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    await listTakes();
    return;
  }
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    process.stderr.write("usage: blackmagic-backtest.ts <take-id|dir> [--expected meters]\n");
    process.exit(1);
  }
  const expectedIndex = args.indexOf("--expected");
  const expectedMeters = expectedIndex >= 0 ? Number(args[expectedIndex + 1]) : null;

  const dir = existsSync(target) ? target : await downloadTake(target);
  const devices = loadTake(dir);
  if (devices.length < 2) {
    process.stderr.write(`need 2 devices in take, found ${devices.length}\n`);
    process.exit(1);
  }
  console.log(`take loaded: ${devices.map((d) => `${d.deviceId.slice(0, 4)}(${d.role}, clock ±${d.clockUncertaintyMs}ms)`).join(", ")}`);

  // 1. Discover the distinct chirp trains present in the take (band ×
  //    duration), without assuming who emitted them: at close range both
  //    phones hear a chirp equally loudly, so loudness cannot attribute.
  const trains = discoverTrains(devices);
  for (const train of trains) {
    console.log(
      `train: ${train.timesSeconds.length} chirps · ${train.band.frequencyHz}-${train.band.endFrequencyHz}Hz ` +
      `${train.durationMs}ms (${train.profile}) · score ${train.meanOwnScore.toFixed(2)} · first at ${train.timesSeconds[0].toFixed(2)}s`,
    );
  }
  if (trains.length < 2) {
    console.log("\nVERDICT: fewer than two distinct chirp trains — at least one phone never emitted; reciprocal ranging impossible in this take.");
    process.exit(0);
  }

  // 2+3. The reciprocal math itself arbitrates attribution: run the full
  //    detection + incremental-ranging replay under both train→device
  //    assignments and keep whichever yields ranges (a wrong assignment
  //    produces negative propagation and derives nothing).
  const [trainA, trainB] = trains;
  const hypotheses = [
    [{ ...trainA, emitterId: devices[0].deviceId }, { ...trainB, emitterId: devices[1].deviceId }],
    [{ ...trainA, emitterId: devices[1].deviceId }, { ...trainB, emitterId: devices[0].deviceId }],
  ];
  let best: ReplayResult | null = null;
  for (const hypothesis of hypotheses) {
    const result = replay(devices, hypothesis);
    if (!best || result.series.length > best.series.length) {
      best = result;
    }
  }
  const { detected, attempted, misses, firstRangeAtSeconds, series, takeSeconds } = best!;
  for (const miss of misses.slice(0, 12)) {
    console.log(`  MISS: ${miss}`);
  }
  console.log(`\ndetections: ${detected}/${attempted}`);

  if (series.length === 0) {
    console.log("VERDICT: detections present but NO ranges derived — inspect anchors above.");
    process.exit(0);
  }
  const meters = series.map((p) => p.meters).sort((a, b) => a - b);
  const median = meters[Math.floor(meters.length / 2)];
  const spread = meters[meters.length - 1] - meters[0];
  console.log(`time to first range: ${firstRangeAtSeconds}s into the take`);
  console.log(`range estimate: median ${median.toFixed(2)}m · min ${meters[0].toFixed(2)} · max ${meters[meters.length - 1].toFixed(2)} · live coverage ${series.length}/${Math.ceil(takeSeconds * 2)} ticks`);
  if (expectedMeters !== null && Number.isFinite(expectedMeters)) {
    // ETOA measures speaker-to-mic acoustic paths; each phone's internal
    // speaker-mic offset adds to the body separation, so allow ~0.15 m.
    const error = Math.abs(median - expectedMeters);
    console.log(`vs expected ${expectedMeters}m: error ${error.toFixed(2)}m ${error <= 0.2 ? "(PASS)" : "(CHECK GEOMETRY)"}`);
  }
  console.log(`stability: max-min spread ${spread.toFixed(2)}m across the take`);
}

function observeWithProductionChain(
  listener: TakeDevice,
  pulse: AcousticPulse,
  nearSeconds: number,
): AcousticObservation | null {
  const { sampleRate, samples } = listener;
  const start = Math.max(0, Math.round((nearSeconds - 0.2) * sampleRate));
  const end = Math.min(samples.length, Math.round((nearSeconds + pulse.durationMs / 1_000 + 0.25) * sampleRate));
  if (end - start < (pulse.durationMs / 1_000) * sampleRate) {
    return null;
  }
  return createMatchedToneObservation({
    pulse,
    audioWindow: {
      samples: samples.slice(start, end),
      sampleRate,
      startSampleIndex: listener.firstSampleIndex + start,
      anchorAudioContextTimeSeconds: 0,
      anchorPerformanceNowMs: 0,
      clientPerfOriginEpochMs:
        listener.startedAtEpochMs - listener.clockOffsetMs - (listener.firstSampleIndex / sampleRate) * 1_000,
      clockOffsetMs: listener.clockOffsetMs,
      clockUncertaintyMs: listener.clockUncertaintyMs,
    },
    searchStartSample: 0,
    searchEndSample: end - start,
    minScore: PRODUCTION_MIN_SCORE,
    minPeakRatio: PRODUCTION_MIN_PEAK_RATIO,
  });
}

type ReplayResult = {
  detected: number;
  attempted: number;
  misses: string[];
  firstRangeAtSeconds: number | null;
  series: Array<{ t: number; meters: number; confidence: number }>;
  takeSeconds: number;
};

// Replay the production chain for one train→device attribution: build the
// pulses, detect every chirp on every recording with the real matched
// filter, then feed the real ranging math incrementally the way the edge
// pipeline does (bounded history, freshness window).
function replay(devices: TakeDevice[], trains: Train[]): ReplayResult {
  const byDevice = new Map<string, { pulses: AcousticPulse[]; observations: AcousticObservation[] }>(
    devices.map((d) => [d.deviceId, { pulses: [], observations: [] }]),
  );
  const hostEpoch = Math.min(...devices.map((d) => d.startedAtEpochMs));
  const misses: string[] = [];
  let attempted = 0;
  let detected = 0;
  for (const train of trains) {
    // Train times are in the reference recording's timeline; convert to the
    // shared epoch through that recording's start time.
    const reference = devices.find((d) => d.deviceId === train.referenceDeviceId)!;
    train.timesSeconds.forEach((t, index) => {
      const pulse: AcousticPulse = {
        id: `bt-${train.emitterId.slice(0, 4)}-${index}`,
        deviceId: train.emitterId,
        sequence: index,
        frequencyHz: train.band.frequencyHz,
        endFrequencyHz: train.band.endFrequencyHz,
        durationMs: train.durationMs,
        emittedAtHostEpochMs: reference.startedAtEpochMs + t * 1_000,
        announcedAtHostEpochMs: 0,
        leadMs: 0,
        sampleRate: reference.sampleRate,
      } as unknown as AcousticPulse;
      byDevice.get(train.emitterId)!.pulses.push(pulse);
      for (const listener of devices) {
        attempted += 1;
        const near = (pulse.emittedAtHostEpochMs - listener.startedAtEpochMs) / 1_000;
        const observation = observeWithProductionChain(listener, pulse, near);
        if (observation) {
          detected += 1;
          byDevice.get(listener.deviceId)!.observations.push(observation);
        } else {
          misses.push(`${listener.deviceId.slice(0, 4)} did not detect ${pulse.id}`);
        }
      }
    });
  }

  let firstRangeAtSeconds: number | null = null;
  const series: Array<{ t: number; meters: number; confidence: number }> = [];
  const takeSeconds = Math.max(...devices.map((d) => d.samples.length / d.sampleRate));
  for (let s = 0; s <= takeSeconds; s += 0.5) {
    const nowEpoch = hostEpoch + s * 1_000;
    const roomDevices: RoomDevice[] = devices.map((d) => ({
      deviceId: d.deviceId,
      joinedAt: 0,
      lastSeenAt: 0,
      role: "phone",
      sessionKey: "backtest",
      acousticPulses: byDevice.get(d.deviceId)!.pulses
        .filter((p) => p.emittedAtHostEpochMs <= nowEpoch)
        .slice(-8),
      acousticObservations: byDevice.get(d.deviceId)!.observations
        .filter((o) => o.detectedAtHostEpochMs <= nowEpoch)
        .slice(-8),
      acousticPulse: null,
      acousticObservation: null,
    } as unknown as RoomDevice));
    const ranges = deriveAcousticRanges(roomDevices, {
      hostEpochNowMs: nowEpoch,
      maxRangeAgeMs: 10_000,
    });
    if (ranges.length > 0) {
      firstRangeAtSeconds ??= s;
      series.push({ t: s, meters: ranges[0].meters, confidence: ranges[0].confidence });
    }
  }
  return { detected, attempted, misses, firstRangeAtSeconds, series, takeSeconds };
}

// The distinct periodic chirp trains in the take, by band × duration. Each
// train is referenced to the recording that captured it most completely.
function discoverTrains(devices: TakeDevice[]): Train[] {
  const found: Train[] = [];
  for (const profile of EMISSION_PROFILES) {
    for (const band of profile.bands) {
      let bestForBand: Train | null = null;
      for (const device of devices) {
        const peaks = findSweepBursts(device, band, profile.durationMs);
        if (peaks.length < 3 || !isPeriodicTrain(peaks.map((p) => p.atSeconds))) {
          continue;
        }
        if (!bestForBand || peaks.length > bestForBand.timesSeconds.length) {
          bestForBand = {
            emitterId: "",
            referenceDeviceId: device.deviceId,
            band,
            durationMs: profile.durationMs,
            profile: profile.label,
            timesSeconds: peaks.map((p) => p.atSeconds),
            meanOwnScore: mean(peaks.map((p) => p.score)),
          };
        }
      }
      if (bestForBand) {
        found.push(bestForBand);
      }
    }
  }
  // Distinct trains only: overlapping bands in different profiles (legacy vs
  // current lanes) can double-count one train — two trains are the same if
  // their chirp times interleave within a slot.
  const distinct: Train[] = [];
  for (const train of found.sort((a, b) => b.timesSeconds.length - a.timesSeconds.length)) {
    const duplicate = distinct.some((kept) => {
      const matches = train.timesSeconds.filter((t) =>
        kept.timesSeconds.some((k) => Math.abs(k - t) < 0.4),
      ).length;
      return matches >= train.timesSeconds.length * 0.5;
    });
    if (!duplicate) {
      distinct.push(train);
    }
  }
  return distinct.slice(0, 2);
}

// Quadrature matched-filter scan, decimated for speed: a coarse hop finds
// burst neighborhoods, a fine pass localizes each peak.
function findSweepBursts(
  device: TakeDevice,
  band: { frequencyHz: number; endFrequencyHz: number },
  durationMs: number,
) {
  const { samples: x, sampleRate: sr } = device;
  const N = Math.round((sr * durationMs) / 1_000);
  const durationSeconds = durationMs / 1_000;
  const sweep = (band.endFrequencyHz - band.frequencyHz) / durationSeconds;
  const tmpl = new Float32Array(N);
  const tmplQ = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    const t = i / sr;
    const phase = 2 * Math.PI * (band.frequencyHz * t + 0.5 * sweep * t * t);
    tmpl[i] = Math.sin(phase);
    tmplQ[i] = Math.cos(phase);
  }
  const scoreAt = (s: number) => {
    let ds = 0;
    let dc = 0;
    let e = 1e-12;
    for (let i = 0; i < N; i += 1) {
      const v = x[s + i];
      ds += v * tmpl[i];
      dc += v * tmplQ[i];
      e += v * v;
    }
    return Math.sqrt(ds * ds + dc * dc) / Math.sqrt((e * N) / 2);
  };

  const coarseHop = Math.round(N / 8);
  const peaks: Array<{ atSeconds: number; score: number }> = [];
  let candidate: { s: number; score: number } | null = null;
  for (let s = 0; s + N <= x.length; s += coarseHop) {
    const score = scoreAt(s);
    if (score >= 0.12) {
      if (!candidate || score > candidate.score) {
        candidate = { s, score };
      }
    } else if (candidate) {
      // refine around the candidate
      let bestS = candidate.s;
      let bestScore = candidate.score;
      for (let s2 = Math.max(0, candidate.s - coarseHop); s2 <= candidate.s + coarseHop && s2 + N <= x.length; s2 += 24) {
        const fine = scoreAt(s2);
        if (fine > bestScore) {
          bestScore = fine;
          bestS = s2;
        }
      }
      peaks.push({ atSeconds: bestS / sr, score: bestScore });
      candidate = null;
    }
  }
  return peaks;
}

// Chirp rotations repeat on a fixed slot cadence; speech does not.
function isPeriodicTrain(timesSeconds: number[]) {
  if (timesSeconds.length < 3) {
    return false;
  }
  const gaps = timesSeconds.slice(1).map((t, i) => t - timesSeconds[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianGap = sorted[Math.floor(sorted.length / 2)];
  return gaps.filter((g) => Math.abs(g - medianGap) < 0.4 || Math.abs(g % medianGap) < 0.4).length >= gaps.length * 0.6;
}

function loadTake(dir: string): TakeDevice[] {
  const devices: TakeDevice[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const meta = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      deviceId: string;
      role: string;
      sampleRate: number;
      firstSampleIndex: number;
      startedAtEpochMs: number;
      clock: { offsetMs: number | null; uncertaintyMs: number | null } | null;
    };
    const wavPath = join(dir, file.replace(/\.json$/, ".wav"));
    if (!existsSync(wavPath)) {
      continue;
    }
    devices.push({
      deviceId: meta.deviceId,
      role: meta.role,
      ...readWav(wavPath),
      firstSampleIndex: meta.firstSampleIndex,
      startedAtEpochMs: meta.startedAtEpochMs,
      clockOffsetMs: meta.clock?.offsetMs ?? 0,
      clockUncertaintyMs: meta.clock?.uncertaintyMs ?? 5,
    });
  }
  return devices;
}

function readWav(path: string) {
  const buffer = readFileSync(path);
  const sampleRate = buffer.readUInt32LE(24);
  const count = (buffer.length - 44) / 2;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = buffer.readInt16LE(44 + 2 * i) / 32768;
  }
  return { samples, sampleRate };
}

async function blobList(prefix?: string) {
  const { list } = await import("@vercel/blob");
  return list(prefix ? { prefix } : { limit: 24 });
}

async function listTakes() {
  const result = await blobList();
  const takes = new Map<string, string>();
  for (const blob of result.blobs) {
    const match = blob.pathname.match(/(take-[a-f0-9]+)\//);
    if (match) {
      takes.set(match[1], blob.uploadedAt as unknown as string);
    }
  }
  for (const [take, at] of [...takes.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1))) {
    console.log(`${at}  ${take}`);
  }
}

async function downloadTake(takeId: string) {
  const dir = join("/tmp", "blackmagic-backtest", takeId);
  mkdirSync(dir, { recursive: true });
  const result = await blobList(`blackmagic/recordings/`);
  const blobs = result.blobs.filter((b) => b.pathname.includes(`/${takeId}/`));
  if (blobs.length === 0) {
    process.stderr.write(`no blobs found for ${takeId} (is BLOB_READ_WRITE_TOKEN set?)\n`);
    process.exit(1);
  }
  for (const blob of blobs) {
    const name = blob.pathname.split("/").pop()!;
    const response = await fetch(blob.url);
    writeFileSync(join(dir, name), Buffer.from(await response.arrayBuffer()));
  }
  console.log(`downloaded ${blobs.length} files to ${dir}`);
  return dir;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
