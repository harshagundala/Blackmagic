import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionStore } from "@/lib/session/store";
import { simulateAcousticRoom } from "../../../../lib/research/acoustic-room-simulator";
import { GET } from "./route";

const state = vi.fn<SessionStore["state"]>();

vi.mock("../../../../lib/session/server-registry", () => ({
  getSessionStore: () => ({
    state,
  }),
}));

describe("session validation route", () => {
  beforeEach(() => {
    state.mockReset();
  });

  test("requires a session url", async () => {
    const response = await GET(
      new Request("https://blackmagic.app/api/session/validation"),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "missing_url" });
    expect(state).not.toHaveBeenCalled();
  });

  test("returns a physical-room validation report for the live room state", async () => {
    const simulation = simulateAcousticRoom({
      roomUrl: "https://blackmagic.app/live-validation",
      devices: [
        { deviceId: "host", x: 0, y: 0 },
        { deviceId: "phone-a", x: 2.2, y: 0.25 },
        { deviceId: "phone-b", x: 0.65, y: 2.15 },
      ],
      exchangesPerPair: 3,
      sampleNoiseStdDev: 0.08,
      speechEvents: [
        {
          id: "speaker-1",
          x: -0.5,
          y: -0.35,
          emittedAtHostEpochMs: 118_000,
        },
      ],
      voiceNoiseMs: 0.04,
    });
    state.mockResolvedValue(simulation.roomState);

    const response = await GET(
      new Request(
        "https://blackmagic.app/api/session/validation?url=https%3A%2F%2Fblackmagic.app%2Flive-validation",
      ),
    );
    const body = (await response.json()) as {
      sessionKey: string;
      revision: number;
      validation: typeof simulation.validation;
    };

    expect(response.status).toBe(200);
    expect(state).toHaveBeenCalledWith("https://blackmagic.app/live-validation");
    expect(body.sessionKey).toBe(simulation.roomState.sessionKey);
    expect(body.revision).toBe(simulation.roomState.revision);
    expect(body.validation.status).toBe("ready");
    expect(body.validation.metrics.tdoaSourceCount).toBe(1);
    expect(body.validation.blockers).toEqual([]);
  });
});
