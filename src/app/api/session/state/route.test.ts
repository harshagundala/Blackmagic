import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionStore } from "@/lib/session/store";
import { GET } from "./route";

const state = vi.fn<SessionStore["state"]>();

vi.mock("@/lib/session/server-registry", () => ({
  getSessionStore: () => ({
    state,
  }),
}));

vi.mock("@/lib/session/registry", () => ({
  compactRoomStateForTransport: <T>(roomState: T) => roomState,
}));

describe("session state route", () => {
  beforeEach(() => {
    state.mockReset();
    state.mockResolvedValue(emptyRoomState());
  });

  test("rejects invalid session urls before touching the store", async () => {
    const response = await GET(
      new Request(
        "https://blackmagic.app/api/session/state?url=not-a-url",
      ),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_url" });
    expect(state).not.toHaveBeenCalled();
  });
});

function emptyRoomState() {
  return {
    sessionKey: "https://blackmagic.app/",
    hostDeviceId: "",
    revision: 0,
    changedAt: 0,
    updatedAt: 1_000,
    calibrationTurn: null,
    timeSync: {
      status: "solo" as const,
      synchronizedDeviceIds: [],
      localizationDeviceIds: [],
      roomConfidence: 0,
      medianMaxErrorMs: null,
      worstLocalizationErrorMs: null,
      devices: [],
    },
    ranges: [],
    devices: [],
    audioEvents: [],
  };
}
