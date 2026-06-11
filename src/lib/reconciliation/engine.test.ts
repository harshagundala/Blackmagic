import { describe, expect, it } from "vitest";
import { ReconciliationEngine } from "./engine";
import {
  mulberry32,
  syntheticVoiceEvent,
  type SceneDevice,
} from "./test-support";

const SESSION_START = 10_000_000;

type Scenario = {
  devices: SceneDevice[];
  utterances: number;
  spacingMs?: number;
  talkerAt: (index: number) => { x: number; y: number };
  seed?: number;
};

function runScenario(engine: ReconciliationEngine, scenario: Scenario) {
  const spacingMs = scenario.spacingMs ?? 2_400;
  const random = mulberry32(scenario.seed ?? 1);
  let lastEpochMs = SESSION_START;
  for (let index = 0; index < scenario.utterances; index += 1) {
    const utteranceEpochMs = SESSION_START + 2_000 + index * spacingMs;
    const talker = scenario.talkerAt(index);
    for (const device of scenario.devices) {
      engine.ingestVoiceEvent(
        device.deviceId,
        syntheticVoiceEvent({
          device,
          talker,
          utteranceEpochMs,
          sessionStartEpochMs: SESSION_START,
          signalSeed: 100 + index,
          noiseSeed: 1_000 + index * 17 + device.deviceId.length,
          vadJitterMs: (random() - 0.5) * 12,
        }),
      );
    }
    lastEpochMs = utteranceEpochMs;
    // Mid-stream snapshots mimic the host's periodic recompute and must not
    // corrupt later results (idempotent ingestion).
    if (index % 5 === 4) {
      engine.snapshot(utteranceEpochMs + 500);
    }
  }
  return engine.snapshot(lastEpochMs + 500);
}

function circleAround(
  center: { x: number; y: number },
  radius: number,
  count: number,
) {
  return (index: number) => ({
    x: center.x + radius * Math.cos((index / count) * 2 * Math.PI * 2.13),
    y: center.y + radius * Math.sin((index / count) * 2 * Math.PI * 2.13),
  });
}

// Synthesizing ~100 snippet windows through the real DSP path is CPU-heavy,
// especially when the whole suite runs in parallel workers.
const SCENE_TIMEOUT_MS = 40_000;

describe("ReconciliationEngine", () => {
  it("measures the distance between two phones from a walking talker", () => {
    const devices: SceneDevice[] = [
      { deviceId: "alpha", x: 0, y: 0, clockErrorMs: -6 },
      { deviceId: "bravo", x: 2.1, y: 0, clockErrorMs: 9 },
    ];
    const engine = new ReconciliationEngine({ anchorDeviceId: "alpha" });
    const snapshot = runScenario(engine, {
      devices,
      utterances: 26,
      talkerAt: circleAround({ x: 1.05, y: 0 }, 1.9, 26),
    });

    expect(snapshot.ranges).toHaveLength(1);
    const [range] = snapshot.ranges;
    expect(Math.abs(range.meters - 2.1)).toBeLessThan(0.3);
    // The ±15 ms clock split must land in the bias, not the distance.
    expect(Math.abs(range.biasMs - 15)).toBeLessThan(1.2);
    expect(snapshot.layout).not.toBeNull();
    const points = snapshot.layout!.points;
    const separation = Math.hypot(
      points.alpha.x - points.bravo.x,
      points.alpha.y - points.bravo.y,
    );
    expect(Math.abs(separation - 2.1)).toBeLessThan(0.35);
  }, SCENE_TIMEOUT_MS);

  it("solves a three-phone constellation and locates the talker", () => {
    const devices: SceneDevice[] = [
      { deviceId: "alpha", x: 0, y: 0, clockErrorMs: 4 },
      { deviceId: "bravo", x: 2.6, y: 0.2, clockErrorMs: -11 },
      { deviceId: "charlie", x: 1.1, y: 2.2, clockErrorMs: 7 },
    ];
    const engine = new ReconciliationEngine({ anchorDeviceId: "alpha" });
    const lastTalker = { x: 2.2, y: 1.6 };
    const snapshot = runScenario(engine, {
      devices,
      utterances: 30,
      talkerAt: (index) =>
        index === 29
          ? lastTalker
          : circleAround({ x: 1.2, y: 0.8 }, 2.3, 29)(index),
    });

    expect(snapshot.ranges.length).toBe(3);
    const truth = new Map<string, number>();
    for (let i = 0; i < devices.length; i += 1) {
      for (let j = i + 1; j < devices.length; j += 1) {
        const key = [devices[i].deviceId, devices[j].deviceId].sort().join("|");
        truth.set(
          key,
          Math.hypot(
            devices[i].x - devices[j].x,
            devices[i].y - devices[j].y,
          ),
        );
      }
    }
    for (const range of snapshot.ranges) {
      const key = [range.from, range.to].sort().join("|");
      expect(Math.abs(range.meters - truth.get(key)!)).toBeLessThan(0.35);
    }

    expect(snapshot.layout).not.toBeNull();
    const points = snapshot.layout!.points;
    for (const [key, expected] of truth) {
      const [a, b] = key.split("|");
      const got = Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
      expect(Math.abs(got - expected)).toBeLessThan(0.4);
    }

    // Talker hint: the layout frame is anchored/rotated arbitrarily, so
    // validate via distances to the devices instead of raw coordinates.
    expect(snapshot.talker).not.toBeNull();
    for (const device of devices) {
      const expectedDistance = Math.hypot(
        lastTalker.x - device.x,
        lastTalker.y - device.y,
      );
      const point = points[device.deviceId];
      const gotDistance = Math.hypot(
        snapshot.talker!.x - point.x,
        snapshot.talker!.y - point.y,
      );
      expect(Math.abs(gotDistance - expectedDistance)).toBeLessThan(0.8);
    }
  }, SCENE_TIMEOUT_MS);

  it("forgets pairs that involve a device that moved", () => {
    const devices: SceneDevice[] = [
      { deviceId: "alpha", x: 0, y: 0, clockErrorMs: 0 },
      { deviceId: "bravo", x: 1.8, y: 0, clockErrorMs: 5 },
    ];
    const engine = new ReconciliationEngine({ anchorDeviceId: "alpha" });
    const beforeMotion = runScenario(engine, {
      devices,
      utterances: 22,
      talkerAt: circleAround({ x: 0.9, y: 0 }, 1.6, 22),
    });
    expect(beforeMotion.ranges).toHaveLength(1);

    const movedAt = beforeMotion.updatedAtHostEpochMs + 1_000;
    for (let tick = 0; tick < 8; tick += 1) {
      engine.noteMotion("bravo", 0.1, movedAt + tick * 150);
    }
    const afterMotion = engine.snapshot(movedAt + 2_000);
    expect(afterMotion.ranges).toHaveLength(0);
  }, SCENE_TIMEOUT_MS);

  it("drops a device's events when it leaves the room", () => {
    const devices: SceneDevice[] = [
      { deviceId: "alpha", x: 0, y: 0, clockErrorMs: 0 },
      { deviceId: "bravo", x: 1.5, y: 0, clockErrorMs: 0 },
    ];
    const engine = new ReconciliationEngine({ anchorDeviceId: "alpha" });
    const snapshot = runScenario(engine, {
      devices,
      utterances: 20,
      talkerAt: circleAround({ x: 0.75, y: 0 }, 1.4, 20),
    });
    expect(snapshot.ranges).toHaveLength(1);

    engine.removeDevice("bravo");
    const after = engine.snapshot(snapshot.updatedAtHostEpochMs + 1_000);
    expect(after.ranges).toHaveLength(0);
    expect(after.deviceIds).toEqual(["alpha"]);
  }, SCENE_TIMEOUT_MS);
});
