import { describe, expect, it } from "vitest";
import {
  parseRecordingPath,
  recordingBasePath,
  sanitizeSegment,
} from "./paths";

describe("sanitizeSegment", () => {
  it("reduces to a dot-free identifier alphabet", () => {
    expect(sanitizeSegment("room/key#1")).toBe("room-key-1");
    expect(sanitizeSegment("take-abc_9")).toBe("take-abc_9");
  });

  it("never yields traversal or empty segments", () => {
    expect(sanitizeSegment("..")).toBe("unknown");
    expect(sanitizeSegment(".")).toBe("unknown");
    expect(sanitizeSegment("...///..")).toBe("unknown");
    expect(sanitizeSegment("")).toBe("unknown");
    expect(sanitizeSegment("///")).toBe("unknown");
  });
});

describe("parseRecordingPath", () => {
  it("accepts exactly the canonical shape and splits it", () => {
    const base = recordingBasePath("session#1", "take-abc", "device 9");
    expect(parseRecordingPath(`${base}.wav`)).toEqual({
      sessionSegment: "session-1",
      recordingSegment: "take-abc",
      deviceSegment: "device-9",
    });
    expect(parseRecordingPath(`${base}.json`)).not.toBeNull();
  });

  it("rejects anything off-shape", () => {
    expect(parseRecordingPath("blackmagic/recordings/a/b/c.mp3")).toBeNull();
    expect(parseRecordingPath("blackmagic/recordings/a/b.wav")).toBeNull();
    expect(parseRecordingPath("blackmagic/recordings/a/b/../c.wav")).toBeNull();
    expect(parseRecordingPath("other/recordings/a/b/c.wav")).toBeNull();
    expect(
      parseRecordingPath("blackmagic/recordings/a/b/c.wav/extra"),
    ).toBeNull();
  });
});
