import { describe, expect, test } from "vitest";
import { waitForRoomStateRevision } from "./wait";
import type { RoomState } from "./registry";
import type { SessionStore } from "./store";

describe("room state long-poll wait", () => {
  test("returns immediately when room revision is already newer", async () => {
    const state = roomState({ revision: 4 });
    const store = fakeStore([state]);

    await expect(
      waitForRoomStateRevision(store, "https://blackmagic.app/", {
        afterRevision: 3,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual(state);
  });

  test("waits until room revision advances", async () => {
    let sleeps = 0;
    const store = fakeStore([
      roomState({ revision: 3 }),
      roomState({ revision: 3 }),
      roomState({ revision: 4 }),
    ]);

    const state = await waitForRoomStateRevision(
      store,
      "https://blackmagic.app/",
      {
        afterRevision: 3,
        timeoutMs: 1_000,
        pollIntervalMs: 50,
        sleep: async () => {
          sleeps += 1;
        },
      },
    );

    expect(state.revision).toBe(4);
    expect(sleeps).toBe(2);
  });

  test("returns the latest state when wait times out", async () => {
    let now = 0;
    const latest = roomState({ revision: 3, updatedAt: 250 });
    const store = fakeStore([roomState({ revision: 3 }), latest]);

    const state = await waitForRoomStateRevision(
      store,
      "https://blackmagic.app/",
      {
        afterRevision: 3,
        timeoutMs: 100,
        pollIntervalMs: 50,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    expect(state).toEqual(latest);
  });

  test("uses cheap revision probes instead of full state reads while waiting", async () => {
    let now = 0;
    let stateCalls = 0;
    let revisionCalls = 0;
    const store: SessionStore = {
      kind: "redis",
      async claim() {
        throw new Error("unused");
      },
      async heartbeat() {
        throw new Error("unused");
      },
      async state() {
        stateCalls += 1;
        return roomState({ revision: 3, updatedAt: now });
      },
      async revision() {
        revisionCalls += 1;
        return 3;
      },
    };

    const state = await waitForRoomStateRevision(
      store,
      "https://blackmagic.app/",
      {
        afterRevision: 3,
        timeoutMs: 1_000,
        pollIntervalMs: 250,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    expect(state.revision).toBe(3);
    expect(stateCalls).toBe(1);
    expect(revisionCalls).toBe(4);
  });

  test("hydrates state after a cheap revision probe observes an advance", async () => {
    let now = 0;
    let stateCalls = 0;
    let revisionCalls = 0;
    const revisions = [3, 4];
    const store: SessionStore = {
      kind: "redis",
      async claim() {
        throw new Error("unused");
      },
      async heartbeat() {
        throw new Error("unused");
      },
      async state() {
        stateCalls += 1;
        return roomState({ revision: stateCalls === 1 ? 3 : 4 });
      },
      async revision() {
        revisionCalls += 1;
        return revisions[Math.min(revisionCalls - 1, revisions.length - 1)];
      },
    };

    const state = await waitForRoomStateRevision(
      store,
      "https://blackmagic.app/",
      {
        afterRevision: 3,
        timeoutMs: 1_000,
        pollIntervalMs: 250,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    expect(state.revision).toBe(4);
    expect(stateCalls).toBe(2);
    expect(revisionCalls).toBe(2);
  });
});

function fakeStore(states: RoomState[]): SessionStore {
  let index = 0;
  return {
    kind: "memory",
    async claim() {
      throw new Error("unused");
    },
    async heartbeat() {
      throw new Error("unused");
    },
    async state() {
      const state = states[Math.min(index, states.length - 1)];
      index += 1;
      return state;
    },
  };
}

function roomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    sessionKey: "https://blackmagic.app/",
    hostDeviceId: "host",
    revision: 1,
    changedAt: 100,
    devices: [],
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
    audioEvents: [],
    updatedAt: 100,
    ...overrides,
  };
}
