import { beforeEach, describe, expect, test, vi } from "vitest";
import { POST } from "./route";
import type { SessionStore } from "@/lib/session/store";

const publishRealtimeSignal =
  vi.fn<SessionStore["publishRealtimeSignal"]>();

vi.mock("@/lib/session/server-registry", () => ({
  getSessionStore: () => ({
    publishRealtimeSignal,
  }),
}));

describe("realtime signal route", () => {
  beforeEach(() => {
    publishRealtimeSignal.mockReset();
  });

  test("publishes WebRTC SDP and ICE envelopes to the recipient inbox", async () => {
    publishRealtimeSignal.mockResolvedValue({
      seq: 12,
      sessionKey: "https://blackmagic.app/room",
      fromDeviceId: "host",
      toDeviceId: "phone-a",
      kind: "offer",
      payload: { type: "offer", sdp: "v=0\r\n" },
      createdAt: 1_000,
    });

    const response = await POST(
      new Request("https://blackmagic.app/api/realtime/signal", {
        method: "POST",
        body: JSON.stringify({
          url: "https://blackmagic.app/room",
          signal: {
            fromDeviceId: "host",
            toDeviceId: "phone-a",
            kind: "offer",
            payload: { type: "offer", sdp: "v=0\r\n" },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        seq: 12,
        fromDeviceId: "host",
        toDeviceId: "phone-a",
        kind: "offer",
      }),
    );
    expect(publishRealtimeSignal).toHaveBeenCalledWith(
      "https://blackmagic.app/room",
      {
        fromDeviceId: "host",
        toDeviceId: "phone-a",
        kind: "offer",
        payload: { type: "offer", sdp: "v=0\r\n" },
      },
    );
  });

  test("rejects malformed or oversized signaling payloads before touching the store", async () => {
    const response = await POST(
      new Request("https://blackmagic.app/api/realtime/signal", {
        method: "POST",
        body: JSON.stringify({
          url: "https://blackmagic.app/room",
          signal: {
            fromDeviceId: "host",
            toDeviceId: "phone-a",
            kind: "offer",
            payload: { type: "offer", sdp: "v=".repeat(40_000) },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_signal",
    });
    expect(publishRealtimeSignal).not.toHaveBeenCalled();
  });

  test("rejects non-web session urls", async () => {
    const response = await POST(
      new Request("https://blackmagic.app/api/realtime/signal", {
        method: "POST",
        body: JSON.stringify({
          url: "javascript:alert(1)",
          signal: {
            fromDeviceId: "host",
            toDeviceId: "phone-a",
            kind: "answer",
            payload: { type: "answer", sdp: "v=0\r\n" },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(publishRealtimeSignal).not.toHaveBeenCalled();
  });
});
