import { describe, expect, test } from "vitest";
import { RollingSampleBuffer } from "./rolling-buffer";

describe("rolling audio sample buffer", () => {
  test("returns the newest contiguous samples with absolute sample indices", () => {
    const buffer = new RollingSampleBuffer(6);

    buffer.append(new Float32Array([1, 2, 3, 4]), 100);
    buffer.append(new Float32Array([5, 6, 7, 8]), 104);

    expect(buffer.latest(5)).toEqual({
      samples: new Float32Array([4, 5, 6, 7, 8]),
      startSampleIndex: 103,
      endSampleIndexExclusive: 108,
    });
  });

  test("limits reads to available samples before the buffer fills", () => {
    const buffer = new RollingSampleBuffer(8);

    buffer.append(new Float32Array([0.1, 0.2, 0.3]), 42);

    expect(buffer.latest(6)).toEqual({
      samples: new Float32Array([0.1, 0.2, 0.3]),
      startSampleIndex: 42,
      endSampleIndexExclusive: 45,
    });
  });

  test("resets history when a non-contiguous capture gap appears", () => {
    const buffer = new RollingSampleBuffer(8);

    buffer.append(new Float32Array([1, 2, 3]), 10);
    buffer.append(new Float32Array([9, 10]), 20);

    expect(buffer.latest(8)).toEqual({
      samples: new Float32Array([9, 10]),
      startSampleIndex: 20,
      endSampleIndexExclusive: 22,
    });
  });
});
