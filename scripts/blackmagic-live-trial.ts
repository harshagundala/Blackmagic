#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createLivePhysicalRoomTrialPlan } from "../src/lib/research/live-trial-plan";

const DEFAULT_ARTIFACT_ROOT = "artifacts/live-trials";
const DEFAULT_BASE_URL = "https://blackmagic-rouge.vercel.app";
const DEFAULT_INTERVAL_MS = 1_500;
const DEFAULT_MIN_DEVICES = 3;
const DEFAULT_READY_STREAK_MS = 5_000;
const DEFAULT_SAMPLES = 80;

let options: ReturnType<typeof parseArgs>;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n\n`);
  printUsage();
  process.exit(1);
}

void main();

async function main() {
  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const plan = createLivePhysicalRoomTrialPlan({
    artifactRoot: options.artifactRoot,
    baseUrl: options.baseUrl,
    generatedAtMs: options.generatedAtMs,
    intervalMs: options.intervalMs,
    minDevices: options.minDevices,
    readyStreakMs: options.readyStreakMs,
    samples: options.samples,
    slug: options.slug,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    printPlan(plan);
  }

  if (options.dryRun) {
    return;
  }

  await mkdir(plan.artifactDirectory, { recursive: true });
  await writeFile(plan.manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`);

  const exitCode = await runTraceCommand(plan.traceCommand);
  process.exit(exitCode);
}

function parseArgs(args: string[]) {
  const generatedAtMs = Date.now();
  const parsed = {
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    baseUrl: DEFAULT_BASE_URL,
    dryRun: false,
    generatedAtMs,
    help: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    json: false,
    minDevices: DEFAULT_MIN_DEVICES,
    readyStreakMs: DEFAULT_READY_STREAK_MS,
    samples: DEFAULT_SAMPLES,
    slug: `field-${generatedAtMs}-${randomBytes(3).toString("hex")}`,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--artifacts-dir":
        parsed.artifactRoot = requireValue(args, ++index, arg);
        break;
      case "--base":
        parsed.baseUrl = requireValue(args, ++index, arg);
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--generated-at-ms":
        parsed.generatedAtMs = Number(requireValue(args, ++index, arg));
        break;
      case "--interval-ms":
        parsed.intervalMs = Number(requireValue(args, ++index, arg));
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--min-devices":
        parsed.minDevices = Number(requireValue(args, ++index, arg));
        break;
      case "--ready-streak-ms":
        parsed.readyStreakMs = Number(requireValue(args, ++index, arg));
        break;
      case "--samples":
        parsed.samples = Number(requireValue(args, ++index, arg));
        break;
      case "--slug":
        parsed.slug = requireValue(args, ++index, arg);
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (
    !Number.isFinite(parsed.generatedAtMs) ||
    parsed.generatedAtMs < 0 ||
    !Number.isFinite(parsed.intervalMs) ||
    parsed.intervalMs < 250 ||
    !Number.isFinite(parsed.minDevices) ||
    parsed.minDevices < 3 ||
    !Number.isFinite(parsed.readyStreakMs) ||
    parsed.readyStreakMs < 0 ||
    !Number.isFinite(parsed.samples) ||
    parsed.samples < 1
  ) {
    throw new Error("Invalid numeric options");
  }

  parsed.minDevices = Math.floor(parsed.minDevices);
  parsed.samples = Math.floor(parsed.samples);
  return parsed;
}

function requireValue(args: string[], index: number, name: string) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function printPlan(plan: ReturnType<typeof createLivePhysicalRoomTrialPlan>) {
  process.stdout.write(`Blackmagic live trial

Open on every phone:
${plan.sessionUrl}

Artifacts:
${plan.artifactDirectory}

Evidence:
${plan.evidencePath}

Trace command:
${plan.traceCommand.join(" ")}
`);
}

async function runTraceCommand(command: string[]) {
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
  });

  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function printUsage() {
  process.stderr.write(`Usage:
  npm run trial:live -- [options]

Options:
  --base <url>              Deployment origin. Default: ${DEFAULT_BASE_URL}
  --slug <slug>             Session path slug. Default: generated unique slug
  --artifacts-dir <path>    Artifact root. Default: ${DEFAULT_ARTIFACT_ROOT}
  --samples <count>         Number of validation samples. Default: ${DEFAULT_SAMPLES}
  --interval-ms <ms>        Delay between samples. Default: ${DEFAULT_INTERVAL_MS}
  --ready-streak-ms <ms>    Required final ready streak. Default: ${DEFAULT_READY_STREAK_MS}
  --min-devices <count>     Planned physical devices. Default: ${DEFAULT_MIN_DEVICES}
  --dry-run                 Print the plan without polling.
  --json                    Print the plan as JSON.
`);
}
