import { beforeEach, describe, expect, test, vi } from "vitest";
import { POST } from "./route";
import type { RoomState } from "@/lib/session/registry";
import type { SessionStore } from "@/lib/session/store";

const heartbeat = vi.fn<SessionStore["heartbeat"]>();

vi.mock("@/lib/session/server-registry", () => ({
  getSessionStore: () => ({
    heartbeat,
  }),
}));

vi.mock("@/lib/session/registry", () => ({
  compactRoomStateForTransport: (state: RoomState) => ({
    ...state,
    devices: state.devices.map((device) => ({
      ...device,
      voiceEvent: device.voiceEvent
        ? { ...device.voiceEvent, audioSnippet: null }
        : device.voiceEvent,
      voiceEvents: device.voiceEvents?.map((event) => ({
        ...event,
        audioSnippet: null,
      })),
    })),
    audioEvents: state.audioEvents.map((event) => ({
      ...event,
      observations: event.observations.map((observation) => ({
        ...observation,
        audioSnippet: null,
      })),
    })),
  }),
}));

describe("session heartbeat route", () => {
  beforeEach(() => {
    heartbeat.mockReset();
  });

  test("strips raw audio snippets from heartbeat room-state responses", async () => {
    heartbeat.mockResolvedValue(roomStateWithSnippet());

    const response = await POST(
      new Request("https://blackmagic.app/api/session/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          deviceId: "host",
          url: "https://blackmagic.app/",
          heartbeat: {},
        }),
      }),
    );
    const body = (await response.json()) as RoomState;

    expect(response.status).toBe(200);
    expect(body.devices[0].voiceEvent?.audioSnippet).toBeNull();
    expect(body.devices[0].voiceEvents?.[0]?.audioSnippet).toBeNull();
    expect(body.audioEvents[0].observations[0].audioSnippet).toBeNull();
  });

  test("rejects non-web session urls before touching the store", async () => {
    heartbeat.mockResolvedValue(roomStateWithSnippet());

    const response = await POST(
      new Request("https://blackmagic.app/api/session/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          deviceId: "host",
          url: "javascript:alert(1)",
          heartbeat: {},
        }),
      }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_url" });
    expect(heartbeat).not.toHaveBeenCalled();
  });
});

function roomStateWithSnippet(): RoomState {
  const audioSnippet = {
    sampleRate: 8_000,
    sourceSampleRate: 48_000,
    startSampleIndex: 1_000,
    centerSampleIndex: 1_960,
    windowMs: 240,
    peakLevel: 0.6,
    encodedSamples: "AAAA",
  };

  return {
    sessionKey: "https://blackmagic.app/",
    hostDeviceId: "host",
    revision: 1,
    changedAt: 1_000,
    updatedAt: 1_000,
    calibrationTurn: null,
    timeSync: {
      status: "solo",
      synchronizedDeviceIds: [],
      localizationDeviceIds: [],
      roomConfidence: 0,
      medianMaxErrorMs: null,
      worstLocalizationErrorMs: null,
      devices: [],
    },
    ranges: [],
    devices: [
      {
        deviceId: "host",
        joinedAt: 1_000,
        lastSeenAt: 1_000,
        role: "host",
        sessionKey: "https://blackmagic.app/",
        voiceEvent: voiceEvent("voice-host", audioSnippet),
        voiceEvents: [voiceEvent("voice-host-history", audioSnippet)],
      },
    ],
    audioEvents: [
      {
        id: "voice:1000:host",
        startedAtHostEpochMs: 1_000,
        endedAtHostEpochMs: 1_000,
        centerHostEpochMs: 1_000,
        timeSpreadMs: 0,
        arrivalLeaderDeviceId: "host",
        observedDeviceIds: ["host"],
        timestampUncertaintyMs: 2,
        timingConfidence: 0.8,
        confidence: 0.8,
        observations: [
          {
            deviceId: "host",
            eventId: "voice-host",
            detectedAtHostEpochMs: 1_000,
            sampleIndex: 48_000,
            sampleRate: 48_000,
            audioLevel: 0.08,
            confidence: 0.8,
            clockUncertaintyMs: 2,
            audioSnippet,
          },
        ],
      },
    ],
  };
}

function voiceEvent(
  id: string,
  audioSnippet: NonNullable<
    NonNullable<RoomState["devices"][number]["voiceEvent"]>["audioSnippet"]
  >,
): NonNullable<RoomState["devices"][number]["voiceEvent"]> {
  return {
    id,
    detectedAtHostEpochMs: 1_000,
    audioContextTimeSeconds: 1,
    sampleIndex: 48_000,
    sampleRate: 48_000,
    audioLevel: 0.08,
    confidence: 0.8,
    clockOffsetMs: 0,
    clockUncertaintyMs: 2,
    audioSnippet,
  };
}
