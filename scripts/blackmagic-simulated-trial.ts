#!/usr/bin/env tsx

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createSimulatedPhysicalRoomTrialEvidence } from "../src/lib/research/simulated-trial-evidence";

const DEFAULT_BASE_URL = "https://blackmagic-rouge.vercel.app";
const DEFAULT_ROOM_URL = "https://blackmagic-rouge.vercel.app/simulated-trial";
const DEFAULT_READY_STREAK_MS = 5_000;

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

  const result = createSimulatedPhysicalRoomTrialEvidence({
    baseUrl: options.baseUrl,
    generatedAtMs: options.generatedAtMs,
    requiredReadyStreakMs: options.readyStreakMs,
    roomUrl: options.roomUrl,
  });
  const output = JSON.stringify(result.evidence, null, 2);

  if (options.out) {
    const outputPath = resolve(options.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${output}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }

  process.stderr.write(
    `${JSON.stringify(
      {
        passed: result.evidence.passed,
        gates: result.evidence.gates,
        maxRangeErrorMeters: result.simulation.maxRangeErrorMeters,
        maxLayoutPairErrorMeters: result.simulation.maxLayoutPairErrorMeters,
        maxSourceDistanceErrorMeters:
          result.simulation.maxSourceDistanceErrorMeters,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(result.evidence.passed ? 0 : 2);
}

function parseArgs(args: string[]) {
  const parsed = {
    baseUrl: DEFAULT_BASE_URL,
    generatedAtMs: Date.now(),
    help: false,
    out: "",
    readyStreakMs: DEFAULT_READY_STREAK_MS,
    roomUrl: DEFAULT_ROOM_URL,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--base":
        parsed.baseUrl = requireValue(args, ++index, arg);
        break;
      case "--generated-at-ms":
        parsed.generatedAtMs = Number(requireValue(args, ++index, arg));
        break;
      case "--out":
        parsed.out = requireValue(args, ++index, arg);
        break;
      case "--ready-streak-ms":
        parsed.readyStreakMs = Number(requireValue(args, ++index, arg));
        break;
      case "--room-url":
        parsed.roomUrl = requireValue(args, ++index, arg);
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
    !Number.isFinite(parsed.readyStreakMs) ||
    parsed.readyStreakMs < 0
  ) {
    throw new Error("Invalid numeric options");
  }

  return parsed;
}

function requireValue(args: string[], index: number, name: string) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function printUsage() {
  process.stderr.write(`Usage:
  npm run trial:simulate -- [options]

Options:
  --base <url>              Evidence base URL. Default: ${DEFAULT_BASE_URL}
  --room-url <url>          Simulated session URL. Default: ${DEFAULT_ROOM_URL}
  --generated-at-ms <ms>    Deterministic evidence timestamp. Default: Date.now()
  --ready-streak-ms <ms>    Required final ready streak. Default: ${DEFAULT_READY_STREAK_MS}
  --out <path>              Write evidence JSON to a file.
`);
}
