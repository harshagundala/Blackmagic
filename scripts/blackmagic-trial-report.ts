#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatPhysicalRoomTrialEvidenceReport } from "../src/lib/research/trial-evidence-report";
import type { PhysicalRoomTrialEvidence } from "../src/lib/research/validation-trace";

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
  if (options.help || !options.evidencePath) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  const evidence = JSON.parse(
    await readFile(resolve(options.evidencePath), "utf8"),
  ) as PhysicalRoomTrialEvidence;
  process.stdout.write(formatPhysicalRoomTrialEvidenceReport(evidence));
  process.exit(evidence.passed ? 0 : 2);
}

function parseArgs(args: string[]) {
  const parsed = {
    evidencePath: "",
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (parsed.evidencePath) {
          throw new Error(`Unexpected argument: ${arg}`);
        }
        parsed.evidencePath = arg;
    }
  }

  return parsed;
}

function printUsage() {
  process.stderr.write(`Usage:
  npm run trial:report -- <trial-evidence.json>
`);
}
