import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Blackmagic session routes", () => {
  test("render the app for arbitrary join URL paths", () => {
    const source = readFileSync("src/app/[...session]/page.tsx", "utf8");

    expect(source).toContain("WaveformApp");
    expect(source).toContain("export default function SessionPage");
  });
});
