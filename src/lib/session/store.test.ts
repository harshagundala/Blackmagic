import { describe, expect, test } from "vitest";
import {
  createMemorySessionStore,
  createRedisSessionStore,
  createResilientSessionStore,
  createSessionStoreFromEnvironment,
  redisRestCredentials,
  type RedisSessionClient,
} from "./store";

describe("session stores", () => {
  test("memory store keeps the existing first-host behavior", async () => {
    const store = createMemorySessionStore();

    await expect(
      store.claim("https://blackmagic.app/", "host"),
    ).resolves.toEqual(expect.objectContaining({ role: "host" }));
    await expect(
      store.claim("https://blackmagic.app/", "phone"),
    ).resolves.toEqual(expect.objectContaining({ role: "phone" }));
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
        timingConfidence: 0.85,
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

  test("redis heartbeat touches an existing room once", async () => {
    let now = 100;
    const redis = new FakeRedisSessionClient();
    const store = createRedisSessionStore(redis, { now: () => now });

    await store.claim("https://blackmagic.app/", "host");
    const before = await store.state("https://blackmagic.app/");

    now = 250;
    redis.resetCalls();
    const after = await store.heartbeat("https://blackmagic.app/", "host", {
      mic: "active",
      micLevel: 0.2,
    });

    expect(after.revision).toBe(before.revision + 1);
    expect(redis.calls.filter((call) => call.startsWith("incr:"))).toHaveLength(
      1,
    );
    expect(redis.calls.filter((call) => call.startsWith("hset:"))).toHaveLength(
      1,
    );
  });

  test("redis heartbeat receipt avoids full room hydration", async () => {
    let now = 100;
    const redis = new FakeRedisSessionClient();
    const store = createRedisSessionStore(redis, { now: () => now });

    await store.claim("https://blackmagic.app/", "host");
    now = 250;
    redis.resetCalls();

    await expect(
      store.heartbeatReceipt("https://blackmagic.app/", "host", {
        mic: "active",
        micLevel: 0.2,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        deviceId: "host",
        role: "host",
        revision: expect.any(Number),
        changedAt: 250,
      }),
    );
    expect(
      redis.calls.filter((call) => call.startsWith("hgetall:")),
    ).toHaveLength(1);
    expect(redis.calls.filter((call) => call.startsWith("incr:"))).toHaveLength(
      1,
    );
  });

  test("redis store reads revisions without hydrating room state", async () => {
    const redis = new FakeRedisSessionClient();
    const store = createRedisSessionStore(redis, { now: () => 100 });
    await store.claim("https://blackmagic.app/", "host");
    const state = await store.state("https://blackmagic.app/");

    redis.resetCalls();

    await expect(store.revision?.("https://blackmagic.app/")).resolves.toBe(
      state.revision,
    );
    expect(redis.calls).toEqual([expect.stringContaining(":revision")]);
  });

  test("redis state reads do not refresh room ttls when nothing changed", async () => {
    const redis = new FakeRedisSessionClient();
    const store = createRedisSessionStore(redis, { now: () => 100 });
    await store.claim("https://blackmagic.app/", "host");

    redis.resetCalls();
    await store.state("https://blackmagic.app/");

    expect(redis.calls.some((call) => call.startsWith("expire:"))).toBe(false);
  });

  test("redis store publishes the next calibration turn from persisted room state", async () => {
    const redis = new FakeRedisSessionClient();
    const store = createRedisSessionStore(redis, { now: () => 100 });

    await store.claim("https://blackmagic.app/", "host");
    await expect(store.state("https://blackmagic.app/")).resolves.toEqual(
      expect.objectContaining({ calibrationTurn: null }),
    );

    await store.heartbeat("https://blackmagic.app/", "host", {
      mic: "active",
      audioFrame: audioFrame(),
    });
    await store.heartbeat("https://blackmagic.app/", "phone-a", {
      mic: "active",
      audioFrame: audioFrame(),
    });

    await expect(store.state("https://blackmagic.app/")).resolves.toEqual(
      expect.objectContaining({
        calibrationTurn: {
          emitterId: "host",
          sequence: 0,
          slotStartsAtHostEpochMs: 0,
          pulseEmittedAtHostEpochMs: 3_400,
          pulseDurationMs: 80,
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

  test("memory store delivers realtime signaling inboxes in sequence order", async () => {
    let now = 10_000;
    const store = createMemorySessionStore({ now: () => now });

    const offer = await store.publishRealtimeSignal(
      "https://blackmagic.app/room",
      {
        fromDeviceId: "host",
        toDeviceId: "phone-a",
        kind: "offer",
        payload: { type: "offer", sdp: "v=0\r\n" },
      },
    );
    now = 10_020;
    const candidate = await store.publishRealtimeSignal(
      "https://blackmagic.app/room",
      {
        fromDeviceId: "host",
        toDeviceId: "phone-a",
        kind: "ice-candidate",
        payload: {
          candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
          sdpMLineIndex: 0,
          sdpMid: "0",
        },
      },
    );

    await expect(
      store.realtimeSignals("https://blackmagic.app/room", "phone-a"),
    ).resolves.toEqual([
      expect.objectContaining({
        seq: offer.seq,
        createdAt: 10_000,
        kind: "offer",
        payload: { type: "offer", sdp: "v=0\r\n" },
      }),
      expect.objectContaining({
        seq: candidate.seq,
        createdAt: 10_020,
        kind: "ice-candidate",
      }),
    ]);
    await expect(
      store.realtimeSignals(
        "https://blackmagic.app/room",
        "phone-a",
        offer.seq,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ seq: candidate.seq, kind: "ice-candidate" }),
    ]);
    await expect(
      store.realtimeSignals("https://blackmagic.app/room", "host"),
    ).resolves.toEqual([]);
  });

  test("redis store persists realtime signaling inboxes across store instances", async () => {
    let now = 2_000;
    const redis = new FakeRedisSessionClient();
    const first = createRedisSessionStore(redis, { now: () => now });

    const offer = await first.publishRealtimeSignal(
      "https://blackmagic.app/room",
      {
        fromDeviceId: "host",
        toDeviceId: "phone-a",
        kind: "offer",
        payload: { type: "offer", sdp: "v=0\r\n" },
      },
    );

    now = 2_050;
    const second = createRedisSessionStore(redis, { now: () => now });
    await expect(
      second.realtimeSignals("https://blackmagic.app/room", "phone-a", 0),
    ).resolves.toEqual([
      expect.objectContaining({
        seq: offer.seq,
        sessionKey: "https://blackmagic.app/room",
        fromDeviceId: "host",
        toDeviceId: "phone-a",
        kind: "offer",
      }),
    ]);
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

  test("redis credentials prefer the Blackmagic-specific store prefix", () => {
    expect(
      redisRestCredentials({
        KV_REST_API_URL: "https://exhausted.upstash.io",
        KV_REST_API_TOKEN: "old-secret",
        BLACKMAGIC_KV_REST_API_URL: "https://fresh.upstash.io",
        BLACKMAGIC_KV_REST_API_TOKEN: "fresh-secret",
      }),
    ).toEqual({
      url: "https://fresh.upstash.io",
      token: "fresh-secret",
      source: "blackmagic-vercel-marketplace-kv",
    });
  });

  test("resilient store falls back to memory when redis is quota exhausted", async () => {
    const store = createResilientSessionStore(
      createRedisSessionStore(new FailingRedisSessionClient()),
      createMemorySessionStore(),
    );

    await expect(
      store.heartbeat("https://blackmagic.app/fallback", "host", {
        mic: "active",
        sampleRate: 48_000,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        hostDeviceId: "host",
        devices: [expect.objectContaining({ deviceId: "host" })],
      }),
    );
    expect(store.kind).toBe("memory");
    await expect(
      store.claim("https://blackmagic.app/fallback", "phone-a"),
    ).resolves.toEqual(expect.objectContaining({ role: "phone" }));
  });

  test("resilient store falls back when a redis revision probe fails", async () => {
    const fallback = createMemorySessionStore();
    await fallback.claim("https://blackmagic.app/fallback", "host");
    const store = createResilientSessionStore(
      createRedisSessionStore(new FailingRedisSessionClient()),
      fallback,
    );

    await expect(
      store.revision?.("https://blackmagic.app/fallback"),
    ).resolves.toBeGreaterThan(0);
    expect(store.kind).toBe("memory");
  });

  test("resilient store falls back for realtime signaling when redis fails", async () => {
    const store = createResilientSessionStore(
      createRedisSessionStore(new FailingRedisSessionClient()),
      createMemorySessionStore({ now: () => 3_000 }),
    );

    const signal = await store.publishRealtimeSignal(
      "https://blackmagic.app/fallback",
      {
        fromDeviceId: "host",
        toDeviceId: "phone",
        kind: "answer",
        payload: { type: "answer", sdp: "v=0\r\n" },
      },
    );

    expect(store.kind).toBe("memory");
    await expect(
      store.realtimeSignals("https://blackmagic.app/fallback", "phone"),
    ).resolves.toEqual([
      expect.objectContaining({ seq: signal.seq, kind: "answer" }),
    ]);
  });
});

function audioFrame() {
  return {
    audioContextTimeSeconds: 1,
    sampleIndex: 48_000,
    sampleRate: 48_000,
    clientPerfOriginEpochMs: 1_700_000_000_000,
    performanceNowMs: 1_000,
    clockOffsetMs: 0,
    clockUncertaintyMs: 2,
    clockQuality: 0.98,
    clockMaxErrorMs: 3,
    clockBestRoundTripMs: 6,
    clockJitterMs: 0.3,
    clockSamplesUsed: 8,
    clockOutliersRejected: 0,
    clockOffsetStabilityMs: 0.3,
    audioElapsedMs: 1_000,
    hostEstimatedEpochMs: 1_700_000_001_000,
    timingConfidence: 0.88,
  };
}

class FakeRedisSessionClient implements RedisSessionClient {
  readonly calls: string[] = [];
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();

  resetCalls() {
    this.calls.length = 0;
  }

  async get(key: string) {
    this.calls.push(`get:${key}`);
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.calls.push(`set:${key}`);
    this.strings.set(key, value);
    return "OK" as const;
  }

  async setnx(key: string, value: string) {
    this.calls.push(`setnx:${key}`);
    if (this.strings.has(key)) {
      return 0;
    }
    this.strings.set(key, value);
    return 1;
  }

  async incr(key: string) {
    this.calls.push(`incr:${key}`);
    const next = Number(this.strings.get(key) ?? "0") + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async del(...keys: string[]) {
    this.calls.push(...keys.map((key) => `del:${key}`));
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
    this.calls.push(`hget:${key}:${field}`);
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string) {
    this.calls.push(`hset:${key}:${field}`);
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const isNew = !hash.has(field);
    hash.set(field, value);
    this.hashes.set(key, hash);
    return isNew ? 1 : 0;
  }

  async hgetall(key: string) {
    this.calls.push(`hgetall:${key}`);
    const hash = this.hashes.get(key);
    if (!hash) {
      return null;
    }
    return Object.fromEntries(hash.entries());
  }

  async hdel(key: string, ...fields: string[]) {
    this.calls.push(...fields.map((field) => `hdel:${key}:${field}`));
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

  async expire(key: string) {
    this.calls.push(`expire:${key}`);
    return 1;
  }
}

class FailingRedisSessionClient implements RedisSessionClient {
  private fail(): never {
    throw new Error("ERR max requests limit exceeded. Limit: 500000");
  }

  async get() {
    return this.fail();
  }

  async set() {
    return this.fail();
  }

  async setnx() {
    return this.fail();
  }

  async incr() {
    return this.fail();
  }

  async del() {
    return this.fail();
  }

  async hget() {
    return this.fail();
  }

  async hset() {
    return this.fail();
  }

  async hgetall() {
    return this.fail();
  }

  async hdel() {
    return this.fail();
  }

  async expire() {
    return this.fail();
  }
}
