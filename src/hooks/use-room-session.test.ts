import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("useRoomSession heartbeat publishing", () => {
  test("dedupes voice events through the heartbeat payload helper", () => {
    const source = readFileSync("src/hooks/use-room-session.ts", "utf8");

    expect(source).toContain("createDeviceHeartbeatPayload");
    expect(source).toContain("acknowledgedVoiceEventId");
    expect(source).toContain("publishedVoiceEventIdRef");
    expect(source).not.toContain("voiceEvent: snapshot.voiceEvent");
  });
});
