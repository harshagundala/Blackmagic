#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_BASE_URL = "https://blackmagic-rouge.vercel.app";
const DEFAULT_INTERVAL_MS = 1_500;
const DEFAULT_SAMPLES = 40;
const DEFAULT_READY_STREAK_MS = 5_000;

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n`);
  printUsage();
  process.exit(1);
}

if (options.help || !options.sessionUrl) {
  printUsage();
  process.exit(options.help ? 0 : 1);
}

const snapshots = [];
let stopped = false;

process.on("SIGINT", () => {
  stopped = true;
});

for (let index = 0; index < options.samples && !stopped; index += 1) {
  const snapshot = await fetchValidationSnapshot(options);
  snapshots.push(snapshot);
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);

  if (index < options.samples - 1 && !stopped) {
    await sleep(options.intervalMs);
  }
}

if (options.out) {
  const outputPath = resolve(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    snapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n") + "\n",
  );
}

const summary = summarize(snapshots, {
  requiredReadyStreakMs: options.readyStreakMs,
});
process.stderr.write(`${JSON.stringify({ summary }, null, 2)}\n`);
process.exit(summary.status === "ready" ? 0 : 2);

function parseArgs(args) {
  const parsed = {
    baseUrl: DEFAULT_BASE_URL,
    intervalMs: DEFAULT_INTERVAL_MS,
    samples: DEFAULT_SAMPLES,
    readyStreakMs: DEFAULT_READY_STREAK_MS,
    sessionUrl: "",
    out: "",
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--base":
        parsed.baseUrl = requireValue(args, ++index, arg);
        break;
      case "--interval-ms":
        parsed.intervalMs = Number(requireValue(args, ++index, arg));
        break;
      case "--samples":
        parsed.samples = Number(requireValue(args, ++index, arg));
        break;
      case "--ready-streak-ms":
        parsed.readyStreakMs = Number(requireValue(args, ++index, arg));
        break;
      case "--out":
        parsed.out = requireValue(args, ++index, arg);
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        parsed.sessionUrl = arg;
    }
  }

  if (
    !Number.isFinite(parsed.intervalMs) ||
    parsed.intervalMs < 250 ||
    !Number.isFinite(parsed.samples) ||
    parsed.samples < 1 ||
    !Number.isFinite(parsed.readyStreakMs) ||
    parsed.readyStreakMs < 0
  ) {
    throw new Error("Invalid numeric options");
  }

  parsed.samples = Math.floor(parsed.samples);
  return parsed;
}

function requireValue(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

async function fetchValidationSnapshot({
  baseUrl,
  sessionUrl,
}) {
  const requestUrl = new URL("/api/session/validation", baseUrl);
  requestUrl.searchParams.set("url", sessionUrl);
  const response = await fetch(requestUrl, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? `Validation request failed: ${response.status}`);
  }

  return {
    capturedAtMs: Date.now(),
    sessionKey: body.sessionKey,
    revision: body.revision,
    updatedAt: body.updatedAt,
    validation: body.validation,
  };
}

function summarize(snapshots, { requiredReadyStreakMs }) {
  const ordered = [...snapshots].sort(
    (left, right) => left.capturedAtMs - right.capturedAtMs,
  );
  if (ordered.length === 0) {
    return {
      status: "empty",
      sampleCount: 0,
      durationMs: 0,
      firstReadyAtMs: null,
      timeToReadyMs: null,
      readyStreakMs: 0,
      finalBlockers: [],
      observedBlockers: [],
      peakDeviceCount: 0,
      peakLocalizedDeviceCount: 0,
      peakRangeCount: 0,
      peakAudioCaptureReadyDeviceCount: 0,
      peakUnverifiedCaptureDeviceCount: 0,
      peakFilteredCaptureDeviceCount: 0,
      peakAudioTimestampReadyDeviceCount: 0,
      worstAudioTimestampErrorMs: null,
      lowestAudioTimingConfidence: null,
      peakTdoaSourceCount: 0,
      bestSourceResidualMs: null,
      devices: [],
    };
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const firstReady = ordered.find(
    (snapshot) => snapshot.validation.status === "ready",
  );
  const readyStreakMs = trailingReadyStreakMs(ordered);

  return {
    status:
      firstReady && readyStreakMs >= requiredReadyStreakMs
        ? "ready"
        : last.validation.status === "ready"
          ? "warming"
          : last.validation.status,
    sampleCount: ordered.length,
    durationMs: Math.max(0, last.capturedAtMs - first.capturedAtMs),
    firstReadyAtMs: firstReady?.capturedAtMs ?? null,
    timeToReadyMs: firstReady
      ? Math.max(0, firstReady.capturedAtMs - first.capturedAtMs)
      : null,
    readyStreakMs,
    finalBlockers: last.validation.blockers,
    observedBlockers: observedBlockers(ordered),
    peakDeviceCount: peakMetric(ordered, "deviceCount"),
    peakLocalizedDeviceCount: peakMetric(ordered, "localizedDeviceCount"),
    peakRangeCount: peakMetric(ordered, "rangeCount"),
    peakAudioCaptureReadyDeviceCount: peakMetric(
      ordered,
      "audioCaptureReadyDeviceCount",
    ),
    peakUnverifiedCaptureDeviceCount: peakMetric(
      ordered,
      "unverifiedCaptureDeviceCount",
    ),
    peakFilteredCaptureDeviceCount: peakMetric(
      ordered,
      "filteredCaptureDeviceCount",
    ),
    peakAudioTimestampReadyDeviceCount: peakMetric(
      ordered,
      "audioTimestampReadyDeviceCount",
    ),
    worstAudioTimestampErrorMs: worstAudioTimestampErrorMs(ordered),
    lowestAudioTimingConfidence: lowestAudioTimingConfidence(ordered),
    peakTdoaSourceCount: peakMetric(ordered, "tdoaSourceCount"),
    bestSourceResidualMs: bestSourceResidualMs(ordered),
    devices: summarizeDevices(ordered),
  };
}

function summarizeDevices(snapshots) {
  const devices = new Map();

  for (const snapshot of snapshots) {
    for (const device of snapshot.validation.devices ?? []) {
      let entry = devices.get(device.deviceId);
      if (!entry) {
        entry = {
          firstSeenAtMs: snapshot.capturedAtMs,
          lastSeenAtMs: snapshot.capturedAtMs,
          sampleCount: 0,
          finalDevice: device,
          observedBlockers: [],
          seenBlockers: new Set(),
          audioTimestampErrors: [],
          audioTimingConfidences: [],
          motionStabilities: [],
        };
        devices.set(device.deviceId, entry);
      }

      entry.lastSeenAtMs = snapshot.capturedAtMs;
      entry.sampleCount += 1;
      entry.finalDevice = device;

      for (const blocker of device.blockers) {
        if (!entry.seenBlockers.has(blocker)) {
          entry.seenBlockers.add(blocker);
          entry.observedBlockers.push(blocker);
        }
      }

      if (typeof device.audioTimestampErrorMs === "number") {
        entry.audioTimestampErrors.push(device.audioTimestampErrorMs);
      }
      if (typeof device.audioTimingConfidence === "number") {
        entry.audioTimingConfidences.push(device.audioTimingConfidence);
      }
      if (typeof device.motionStability === "number") {
        entry.motionStabilities.push(device.motionStability);
      }
    }
  }

  return [...devices.entries()].map(([deviceId, entry]) => {
    const finalDevice = entry.finalDevice;
    return {
      deviceId,
      role: finalDevice.role,
      sampleCount: entry.sampleCount,
      firstSeenAtMs: entry.firstSeenAtMs,
      lastSeenAtMs: entry.lastSeenAtMs,
      finalBlockers: [...finalDevice.blockers],
      observedBlockers: entry.observedBlockers,
      finalLocalized: finalDevice.localized,
      finalDistanceMeters: finalDevice.distanceMeters,
      finalCaptureStatus: finalDevice.captureStatus,
      finalAudioCaptureReady: finalDevice.audioCaptureReady,
      finalAudioTimestampReady: finalDevice.audioTimestampReady,
      worstAudioTimestampErrorMs:
        entry.audioTimestampErrors.length === 0
          ? null
          : Math.max(...entry.audioTimestampErrors),
      lowestAudioTimingConfidence:
        entry.audioTimingConfidences.length === 0
          ? null
          : Math.min(...entry.audioTimingConfidences),
      lowestMotionStability:
        entry.motionStabilities.length === 0
          ? null
          : Math.min(...entry.motionStabilities),
    };
  });
}

function trailingReadyStreakMs(snapshots) {
  let readySinceMs = null;
  for (const snapshot of snapshots) {
    if (snapshot.validation.status !== "ready") {
      readySinceMs = null;
      continue;
    }
    readySinceMs ??= snapshot.capturedAtMs;
  }

  return readySinceMs === null
    ? 0
    : Math.max(0, snapshots[snapshots.length - 1].capturedAtMs - readySinceMs);
}

function observedBlockers(snapshots) {
  const blockers = [];
  const seen = new Set();
  for (const snapshot of snapshots) {
    for (const blocker of snapshot.validation.blockers) {
      if (!seen.has(blocker)) {
        seen.add(blocker);
        blockers.push(blocker);
      }
    }
  }
  return blockers;
}

function peakMetric(snapshots, metric) {
  return Math.max(
    0,
    ...snapshots.map((snapshot) => snapshot.validation.metrics[metric] ?? 0),
  );
}

function bestSourceResidualMs(snapshots) {
  const residuals = snapshots
    .map((snapshot) => snapshot.validation.metrics.bestSourceResidualMs)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return residuals.length === 0 ? null : Math.min(...residuals);
}

function worstAudioTimestampErrorMs(snapshots) {
  const errors = snapshots
    .map((snapshot) => snapshot.validation.metrics.worstAudioTimestampErrorMs)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return errors.length === 0 ? null : Math.max(...errors);
}

function lowestAudioTimingConfidence(snapshots) {
  const confidences = snapshots
    .map((snapshot) => snapshot.validation.metrics.lowestAudioTimingConfidence)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return confidences.length === 0 ? null : Math.min(...confidences);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage() {
  process.stderr.write(`Usage:
  npm run trace:validation -- <session-url> [options]

Options:
  --base <url>              Validation API origin. Default: ${DEFAULT_BASE_URL}
  --samples <count>         Number of samples. Default: ${DEFAULT_SAMPLES}
  --interval-ms <ms>        Delay between samples. Default: ${DEFAULT_INTERVAL_MS}
  --ready-streak-ms <ms>    Required final ready streak. Default: ${DEFAULT_READY_STREAK_MS}
  --out <path>              Write NDJSON snapshots to a file.
`);
}
