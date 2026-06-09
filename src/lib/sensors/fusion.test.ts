import { describe, expect, test } from "vitest";
import {
  estimateMotionStability,
  motionMetadataFromReading,
} from "./fusion";

describe("sensor fusion metadata", () => {
  test("scores a still phone as stable from gravity and low rotation", () => {
    const metadata = motionMetadataFromReading({
      accelerationIncludingGravity: { x: 0.03, y: -0.04, z: 9.81 },
      rotationRate: { alpha: 0.4, beta: 0.3, gamma: 0.2 },
      intervalMs: 16.7,
      capturedAtClientPerfMs: 1_234.5,
    });

    expect(metadata.motionAccelerationMagnitude).toBeLessThan(0.08);
    expect(metadata.motionRotationRateDegPerSec).toBeLessThan(0.6);
    expect(metadata.motionIntervalMs).toBe(16.7);
    expect(metadata.motionCapturedAtClientPerfMs).toBe(1_234.5);
    expect(metadata.motionStability).toBeGreaterThan(0.9);
  });

  test("scores a translating and rotating phone as unstable", () => {
    const metadata = motionMetadataFromReading({
      acceleration: { x: 2.4, y: -1.1, z: 0.6 },
      accelerationIncludingGravity: { x: 2.4, y: -1.1, z: 10.4 },
      rotationRate: { alpha: 96, beta: -42, gamma: 38 },
      intervalMs: 16.7,
    });

    expect(metadata.motionAccelerationMagnitude).toBeGreaterThan(2.6);
    expect(metadata.motionRotationRateDegPerSec).toBeGreaterThan(110);
    expect(metadata.motionStability).toBeLessThan(0.18);
  });

  test("keeps stability bounded when only one motion channel is present", () => {
    expect(
      estimateMotionStability({
        accelerationMagnitude: null,
        rotationRateDegPerSec: 12,
      }),
    ).toBeGreaterThan(0.7);
    expect(
      estimateMotionStability({
        accelerationMagnitude: 0.8,
        rotationRateDegPerSec: null,
      }),
    ).toBeGreaterThan(0.55);
  });
});
