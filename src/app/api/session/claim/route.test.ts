import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionStore } from "@/lib/session/store";
import { POST } from "./route";

const claim = vi.fn<SessionStore["claim"]>();

vi.mock("@/lib/session/server-registry", () => ({
  getSessionStore: () => ({
    claim,
  }),
}));

describe("session claim route", () => {
  beforeEach(() => {
    claim.mockReset();
    claim.mockResolvedValue({
      deviceId: "host",
      joinedAt: 1_000,
      lastSeenAt: 1_000,
      role: "host",
      sessionKey: "https://blackmagic.app/",
    });
  });

  test("rejects invalid session urls before touching the store", async () => {
    const response = await POST(
      new Request("https://blackmagic.app/api/session/claim", {
        method: "POST",
        body: JSON.stringify({
          deviceId: "host",
          url: "not-a-url",
        }),
      }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_url" });
    expect(claim).not.toHaveBeenCalled();
  });
});
