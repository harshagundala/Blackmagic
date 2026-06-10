import { posix as path } from "node:path";

export type LivePhysicalRoomTrialPlanOptions = {
  artifactRoot: string;
  baseUrl: string;
  generatedAtMs: number;
  intervalMs?: number;
  minDevices?: number;
  readyStreakMs?: number;
  samples?: number;
  slug?: string;
};

export type LivePhysicalRoomTrialManifest = {
  artifactDirectory: string;
  baseUrl: string;
  generatedAtMs: number;
  intervalMs: number;
  minDevices: number;
  readyStreakMs: number;
  samples: number;
  sessionUrl: string;
  slug: string;
  traceCommand: string[];
};

export type LivePhysicalRoomTrialPlan = {
  artifactDirectory: string;
  evidencePath: string;
  manifest: LivePhysicalRoomTrialManifest;
  manifestPath: string;
  sessionUrl: string;
  slug: string;
  traceCommand: string[];
  tracePath: string;
};

const DEFAULT_INTERVAL_MS = 1_500;
const DEFAULT_MIN_DEVICES = 3;
const DEFAULT_READY_STREAK_MS = 5_000;
const DEFAULT_SAMPLES = 80;

export function createLivePhysicalRoomTrialPlan({
  artifactRoot,
  baseUrl,
  generatedAtMs,
  intervalMs = DEFAULT_INTERVAL_MS,
  minDevices = DEFAULT_MIN_DEVICES,
  readyStreakMs = DEFAULT_READY_STREAK_MS,
  samples = DEFAULT_SAMPLES,
  slug,
}: LivePhysicalRoomTrialPlanOptions): LivePhysicalRoomTrialPlan {
  if (
    !Number.isFinite(generatedAtMs) ||
    generatedAtMs < 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 250 ||
    !Number.isFinite(minDevices) ||
    minDevices < 3 ||
    !Number.isFinite(readyStreakMs) ||
    readyStreakMs < 0 ||
    !Number.isFinite(samples) ||
    samples < 1
  ) {
    throw new Error("Invalid live trial capture settings");
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedSlug = normalizeSlug(slug, generatedAtMs);
  const sessionUrl = new URL(`${normalizedSlug}`, `${normalizedBaseUrl}/`).toString();
  const normalizedArtifactRoot = normalizeArtifactRoot(artifactRoot);
  const artifactDirectory = path.join(normalizedArtifactRoot, normalizedSlug);
  const tracePath = path.join(artifactDirectory, "validation-trace.ndjson");
  const evidencePath = path.join(artifactDirectory, "trial-evidence.json");
  const manifestPath = path.join(artifactDirectory, "trial-manifest.json");
  const traceCommand = [
    "npm",
    "run",
    "trace:validation",
    "--",
    sessionUrl,
    "--base",
    normalizedBaseUrl,
    "--samples",
    String(samples),
    "--interval-ms",
    String(intervalMs),
    "--ready-streak-ms",
    String(readyStreakMs),
    "--out",
    tracePath,
    "--evidence-out",
    evidencePath,
  ];
  const manifest: LivePhysicalRoomTrialManifest = {
    artifactDirectory,
    baseUrl: normalizedBaseUrl,
    generatedAtMs,
    intervalMs,
    minDevices,
    readyStreakMs,
    samples,
    sessionUrl,
    slug: normalizedSlug,
    traceCommand,
  };

  return {
    artifactDirectory,
    evidencePath,
    manifest,
    manifestPath,
    sessionUrl,
    slug: normalizedSlug,
    traceCommand,
    tracePath,
  };
}

function normalizeBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("baseUrl must be an http(s) URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeArtifactRoot(artifactRoot: string) {
  const normalized = artifactRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized.includes("\0")) {
    throw new Error("artifactRoot must be a non-empty directory");
  }
  return normalized;
}

function normalizeSlug(slug: string | undefined, generatedAtMs: number) {
  const raw = slug?.trim() || defaultSlug(generatedAtMs);
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");

  if (!normalized) {
    throw new Error("slug must contain at least one letter or number");
  }
  return normalized;
}

function defaultSlug(generatedAtMs: number) {
  const date = new Date(generatedAtMs);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("generatedAtMs must be a finite timestamp");
  }
  return `field-trial-${date.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}
