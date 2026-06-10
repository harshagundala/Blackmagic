import { beforeEach, describe, expect, test, vi } from "vitest";
import { GET } from "./route";
import type { SessionStore } from "@/lib/session/store";

const realtimeSignals = vi.fn<SessionStore["realtimeSignals"]>();

vi.mock("@/lib/session/server-registry", () => ({
  getSessionStore: () => ({
    realtimeSignals,
  }),
}));

describe("realtime signals route", () => {
  beforeEach(() => {
    realtimeSignals.mockReset();
  });

  test("returns recipient WebRTC signaling inbox entries after a sequence", async () => {
    realtimeSignals.mockResolvedValue([
      {
        seq: 8,
        sessionKey: "https://blackmagic.app/room",
        fromDeviceId: "host",
        toDeviceId: "phone-a",
        kind: "ice-candidate",
        payload: {
          candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
          sdpMLineIndex: 0,
          sdpMid: "0",
        },
        createdAt: 1_000,
      },
    ]);

    const response = await GET(
      new Request(
        "https://blackmagic.app/api/realtime/signals?url=https%3A%2F%2Fblackmagic.app%2Froom&deviceId=phone-a&since=7",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      signals: [
        expect.objectContaining({
          seq: 8,
          fromDeviceId: "host",
          toDeviceId: "phone-a",
          kind: "ice-candidate",
        }),
      ],
    });
    expect(realtimeSignals).toHaveBeenCalledWith(
      "https://blackmagic.app/room",
      "phone-a",
      7,
    );
  });

  test("rejects missing device ids before touching the store", async () => {
    const response = await GET(
      new Request(
        "https://blackmagic.app/api/realtime/signals?url=https%3A%2F%2Fblackmagic.app%2Froom",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "missing_device_or_url",
    });
    expect(realtimeSignals).not.toHaveBeenCalled();
  });
});
