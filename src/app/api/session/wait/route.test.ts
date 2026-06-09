import { beforeEach, describe, expect, test, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  waitForRoomStateRevision: vi.fn(),
}));

vi.mock("@/lib/session/server-registry", () => ({
  getSessionStore: () => ({
    state: mocks.state,
  }),
}));

vi.mock("@/lib/session/wait", () => ({
  waitForRoomStateRevision: mocks.waitForRoomStateRevision,
}));

vi.mock("@/lib/session/registry", () => ({
  compactRoomStateForTransport: <T>(roomState: T) => roomState,
}));

describe("session wait route", () => {
  beforeEach(() => {
    mocks.state.mockReset();
    mocks.waitForRoomStateRevision.mockReset();
    mocks.waitForRoomStateRevision.mockResolvedValue(emptyRoomState());
  });

  test("rejects invalid session urls before starting the wait loop", async () => {
    const response = await GET(
      new Request(
        "https://blackmagic.app/api/session/wait?url=ftp%3A%2F%2Fexample.com%2Froom",
      ),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_url" });
    expect(mocks.waitForRoomStateRevision).not.toHaveBeenCalled();
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
