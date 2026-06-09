import { describe, expect, test } from "vitest";
import {
  createMemorySessionStore,
  createRedisSessionStore,
  createSessionStoreFromEnvironment,
  type RedisSessionClient,
} from "./store";

describe("session stores", () => {
  test("memory store keeps the existing first-host behavior", async () => {
    const store = createMemorySessionStore();

    await expect(store.claim("https://blackmagic.app/", "host")).resolves.toEqual(
      expect.objectContaining({ role: "host" }),
    );
    await expect(store.claim("https://blackmagic.app/", "phone")).resolves.toEqual(
      expect.objectContaining({ role: "phone" }),
    );
  });

  test("redis store persists room presence across fresh store instances", async () => {
    let now = 1_000;
    const redis = new FakeRedisSessionClient();
    const first = createRedisSessionStore(redis, {
      now: () => now,
      staleAfterMs: 5_000,
    });

    expect(await first.claim("https://blackmagic.app/", "host")).toEqual(
      expect.objectContaining({ role: "host" }),
    );

    const second = createRedisSessionStore(redis, {
      now: () => now,
      staleAfterMs: 5_000,
    });

    expect(await second.claim("https://blackmagic.app/", "phone")).toEqual(
      expect.objectContaining({ role: "phone" }),
    );

    now = 2_000;
    const state = await second.heartbeat("https://blackmagic.app/", "phone", {
      mic: "active",
      micLevel: 0.18,
      sampleRate: 48_000,
      clockQuality: 0.98,
      clockUncertaintyMs: 2,
      audioFrame: {
        audioContextTimeSeconds: 5,
        sampleIndex: 240_000,
        sampleRate: 48_000,
        clientPerfOriginEpochMs: 1_780_000_000_000,
        performanceNowMs: 2_000,
        clockOffsetMs: 1.5,
        clockUncertaintyMs: 2,
        audioElapsedMs: 5_000,
        hostEstimatedEpochMs: 1_780_000_002_001.5,
      },
      motion: "active",
      heading: "active",
      location: "blocked",
    });

    expect(state.hostDeviceId).toBe("host");
    expect(state.devices).toEqual([
      expect.objectContaining({ deviceId: "host", role: "host" }),
      expect.objectContaining({
        deviceId: "phone",
        role: "phone",
        sampleRate: 48_000,
        audioFrame: expect.objectContaining({
          sampleIndex: 240_000,
          hostEstimatedEpochMs: 1_780_000_002_001.5,
        }),
      }),
    ]);
  });

  test("redis store persists mutation revisions separately from read timestamps", async () => {
    let now = 100;
    const redis = new FakeRedisSessionClient();
    const store = createRedisSessionStore(redis, { now: () => now });

    await store.claim("https://blackmagic.app/", "host");
    now = 150;
    const firstRead = await store.state("https://blackmagic.app/");
    now = 200;
    const secondRead = await store.state("https://blackmagic.app/");

    expect(firstRead.revision).toBeGreaterThan(0);
    expect(firstRead.changedAt).toBe(100);
    expect(firstRead.updatedAt).toBe(150);
    expect(secondRead.revision).toBe(firstRead.revision);
    expect(secondRead.changedAt).toBe(firstRead.changedAt);
    expect(secondRead.updatedAt).toBe(200);

    now = 250;
    const heartbeatState = await store.heartbeat(
      "https://blackmagic.app/",
      "host",
      { micLevel: 0.2 },
    );

    expect(heartbeatState.revision).toBeGreaterThan(secondRead.revision);
    expect(heartbeatState.changedAt).toBe(250);
  });

  test("redis store publishes the next calibration turn from persisted room state", async () => {
    const redis = new FakeRedisSessionClient();
    const store = createRedisSessionStore(redis, { now: () => 100 });

    await store.claim("https://blackmagic.app/", "host");
    await expect(store.state("https://blackmagic.app/")).resolves.toEqual(
      expect.objectContaining({ calibrationTurn: null }),
    );

    await store.claim("https://blackmagic.app/", "phone-a");

    await expect(store.state("https://blackmagic.app/")).resolves.toEqual(
      expect.objectContaining({
        calibrationTurn: {
          emitterId: "host",
          sequence: 0,
          slotStartsAtHostEpochMs: 0,
          pulseEmittedAtHostEpochMs: 3_400,
          pulseDurationMs: 48,
        },
      }),
    );
  });

  test("redis store exposes room time sync health from persisted heartbeats", async () => {
    const redis = new FakeRedisSessionClient();
    const store = createRedisSessionStore(redis, { now: () => 20_000 });

    await store.heartbeat("https://blackmagic.app/", "host", {
      clockQuality: 0.97,
      clockUncertaintyMs: 2,
      clockMaxErrorMs: 3,
      clockBestRoundTripMs: 10,
      clockJitterMs: 0.6,
      clockSamplesUsed: 9,
      clockOffsetStabilityMs: 0.5,
    });
    await store.heartbeat("https://blackmagic.app/", "phone", {
      clockQuality: 0.9,
      clockUncertaintyMs: 4,
      clockMaxErrorMs: 5,
      clockBestRoundTripMs: 20,
      clockJitterMs: 1.5,
      clockSamplesUsed: 6,
      clockOffsetStabilityMs: 1.4,
    });

    await expect(store.state("https://blackmagic.app/")).resolves.toEqual(
      expect.objectContaining({
        timeSync: expect.objectContaining({
          status: "ready",
          synchronizedDeviceIds: ["host", "phone"],
          localizationDeviceIds: ["host", "phone"],
          medianMaxErrorMs: 4,
          worstLocalizationErrorMs: 5,
        }),
      }),
    );
  });

  test("redis store releases a stale host across store instances", async () => {
    let now = 1_000;
    const redis = new FakeRedisSessionClient();

    const first = createRedisSessionStore(redis, {
      now: () => now,
      staleAfterMs: 5_000,
    });
    expect(await first.claim("https://blackmagic.app/", "host")).toEqual(
      expect.objectContaining({ role: "host" }),
    );

    now = 8_000;
    const next = createRedisSessionStore(redis, {
      now: () => now,
      staleAfterMs: 5_000,
    });

    expect(await next.claim("https://blackmagic.app/", "next")).toEqual(
      expect.objectContaining({ role: "host" }),
    );
    await expect(next.state("https://blackmagic.app/")).resolves.toEqual(
      expect.objectContaining({
        hostDeviceId: "next",
        devices: [expect.objectContaining({ deviceId: "next", role: "host" })],
      }),
    );
  });

  test("store selector uses memory until Upstash Redis env is present", () => {
    expect(createSessionStoreFromEnvironment({}).kind).toBe("memory");
    expect(
      createSessionStoreFromEnvironment({
        UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "secret",
      }).kind,
    ).toBe("redis");
    expect(
      createSessionStoreFromEnvironment({
        KV_REST_API_URL: "https://example.upstash.io",
        KV_REST_API_TOKEN: "secret",
      }).kind,
    ).toBe("redis");
  });
});

class FakeRedisSessionClient implements RedisSessionClient {
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.strings.set(key, value);
    return "OK" as const;
  }

  async setnx(key: string, value: string) {
    if (this.strings.has(key)) {
      return 0;
    }
    this.strings.set(key, value);
    return 1;
  }

  async incr(key: string) {
    const next = Number(this.strings.get(key) ?? "0") + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async del(...keys: string[]) {
    let deleted = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) {
        deleted += 1;
      }
      if (this.hashes.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async hget(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const isNew = !hash.has(field);
    hash.set(field, value);
    this.hashes.set(key, hash);
    return isNew ? 1 : 0;
  }

  async hgetall(key: string) {
    const hash = this.hashes.get(key);
    if (!hash) {
      return null;
    }
    return Object.fromEntries(hash.entries());
  }

  async hdel(key: string, ...fields: string[]) {
    const hash = this.hashes.get(key);
    if (!hash) {
      return 0;
    }
    let deleted = 0;
    for (const field of fields) {
      if (hash.delete(field)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async expire() {
    return 1;
  }
}
