import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createLivePhysicalRoomTrialPlan } from "./live-trial-plan";

describe("live trial plan", () => {
  test("creates a shareable session URL and deterministic evidence artifacts", () => {
    const plan = createLivePhysicalRoomTrialPlan({
      artifactRoot: "artifacts/live-trials",
      baseUrl: "https://blackmagic-rouge.vercel.app",
      generatedAtMs: Date.UTC(2026, 5, 10, 1, 2, 3),
      intervalMs: 1_250,
      readyStreakMs: 6_000,
      samples: 72,
      slug: "office table / first pass",
    });

    expect(plan.slug).toBe("office-table-first-pass");
    expect(plan.sessionUrl).toBe(
      "https://blackmagic-rouge.vercel.app/office-table-first-pass",
    );
    expect(plan.artifactDirectory).toBe(
      "artifacts/live-trials/office-table-first-pass",
    );
    expect(plan.tracePath).toBe(
      "artifacts/live-trials/office-table-first-pass/validation-trace.ndjson",
    );
    expect(plan.evidencePath).toBe(
      "artifacts/live-trials/office-table-first-pass/trial-evidence.json",
    );
    expect(plan.manifestPath).toBe(
      "artifacts/live-trials/office-table-first-pass/trial-manifest.json",
    );
    expect(plan.traceCommand).toEqual([
      "npm",
      "run",
      "trace:validation",
      "--",
      "https://blackmagic-rouge.vercel.app/office-table-first-pass",
      "--base",
      "https://blackmagic-rouge.vercel.app",
      "--samples",
      "72",
      "--interval-ms",
      "1250",
      "--ready-streak-ms",
      "6000",
      "--out",
      "artifacts/live-trials/office-table-first-pass/validation-trace.ndjson",
      "--evidence-out",
      "artifacts/live-trials/office-table-first-pass/trial-evidence.json",
    ]);
    expect(plan.manifest).toMatchObject({
      artifactDirectory: plan.artifactDirectory,
      minDevices: 3,
      sessionUrl: plan.sessionUrl,
    });
  });

  test("prints the live trial plan without polling in dry-run mode", () => {
    const result = spawnSync(
      "npm",
      [
        "--silent",
        "run",
        "trial:live",
        "--",
        "--dry-run",
        "--json",
        "--base",
        "https://blackmagic-rouge.vercel.app",
        "--slug",
        "lab dry run",
        "--generated-at-ms",
        "1781053323000",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const plan = JSON.parse(result.stdout) as {
      sessionUrl: string;
      traceCommand: string[];
    };

    expect(plan.sessionUrl).toBe(
      "https://blackmagic-rouge.vercel.app/lab-dry-run",
    );
    expect(plan.traceCommand.join(" ")).toContain("trace:validation");
  });

  test("rejects physically meaningless capture settings", () => {
    expect(() =>
      createLivePhysicalRoomTrialPlan({
        artifactRoot: "artifacts/live-trials",
        baseUrl: "https://blackmagic-rouge.vercel.app",
        generatedAtMs: Date.UTC(2026, 5, 10),
        intervalMs: 100,
        minDevices: 2,
        samples: 0,
        slug: "bad-plan",
      }),
    ).toThrow("Invalid live trial capture settings");
  });
});
