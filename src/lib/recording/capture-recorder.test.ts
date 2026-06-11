import { describe, expect, it } from "vitest";
import { CaptureRecorder } from "./capture-recorder";
import { encodeWavPcm16 } from "./wav";

function chunk(values: number[]) {
  return new Float32Array(values);
}

describe("CaptureRecorder", () => {
  it("accumulates contiguous worklet chunks into one take", () => {
    const recorder = new CaptureRecorder();
    recorder.begin({ recordingId: "rec-1", startedAtEpochMs: 1_000 });
    recorder.append(chunk([0, 0.5, -0.5]), 100, 48_000);
    recorder.append(chunk([1, -1]), 103, 48_000);

    const take = recorder.end(2_000);
    expect(take).not.toBeNull();
    expect(take!.recordingId).toBe("rec-1");
    expect(take!.sampleRate).toBe(48_000);
    expect(take!.firstSampleIndex).toBe(100);
    expect(take!.lastSampleIndex).toBe(104);
    expect(take!.discontinuities).toHaveLength(0);
    expect([...take!.samples]).toEqual([0, 16384, -16383, 32767, -32767]);
    expect(recorder.active).toBe(false);
  });

  it("marks sample-counter discontinuities instead of hiding them", () => {
    const recorder = new CaptureRecorder();
    recorder.begin({ recordingId: "rec-2", startedAtEpochMs: 0 });
    recorder.append(chunk([0.1, 0.1]), 0, 48_000);
    // 10 samples vanished (dropped quanta under load).
    recorder.append(chunk([0.2, 0.2]), 12, 48_000);
    // Counter went backwards: capture graph restarted.
    recorder.append(chunk([0.3]), 4, 48_000);

    const take = recorder.end(1_000);
    expect(take!.discontinuities).toEqual([
      { atRecordedSample: 2, missingSamples: 10 },
      { atRecordedSample: 4, missingSamples: -10 },
    ]);
  });

  it("ignores chunks when idle and returns null without data", () => {
    const recorder = new CaptureRecorder();
    recorder.append(chunk([0.5]), 0, 48_000);
    expect(recorder.active).toBe(false);

    recorder.begin({ recordingId: "rec-3", startedAtEpochMs: 0 });
    expect(recorder.end(10)).toBeNull();
  });

  it("truncates instead of exhausting memory", () => {
    const recorder = new CaptureRecorder();
    recorder.begin({ recordingId: "rec-4", startedAtEpochMs: 0 });
    const big = new Float32Array(48_000 * 60);
    recorder.append(big, 0, 48_000);
    recorder.append(big, big.length, 48_000);
    recorder.append(big, big.length * 2, 48_000);
    // Fourth minute crosses the 180 s cap and is dropped.
    recorder.append(big, big.length * 3, 48_000);

    const take = recorder.end(1);
    expect(take!.truncated).toBe(true);
    expect(take!.samples.length).toBe(48_000 * 180);
  });
});

describe("encodeWavPcm16", () => {
  it("writes a canonical 44-byte header", () => {
    const wav = encodeWavPcm16(new Int16Array([1, -1, 32767]), 48_000);
    const view = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 6);
    expect(String.fromCharCode(...new Uint8Array(wav, 0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...new Uint8Array(wav, 8, 4))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(6);
    expect(new Int16Array(wav, 44)[2]).toBe(32767);
  });
});
