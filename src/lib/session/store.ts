import { createHash } from "node:crypto";
import {
  DEFAULT_STALE_AFTER_MS,
  createSessionRegistry,
  mergeHeartbeat,
  normalizeSessionKey,
  selectRoomCalibrationTurn,
  type DeviceHeartbeat,
  type RoomDevice,
  type RoomState,
  type SessionClaim,
} from "./registry";
import { deriveReconciledAudioEvents } from "./audio-events";
import { deriveAcousticRanges } from "./ranging";
import { deriveRoomTimeSync } from "./timing-health";

export type SessionStore = {
  kind: "memory" | "redis";
  claim(url: string, deviceId: string): Promise<SessionClaim>;
  heartbeat(
    url: string,
    deviceId: string,
    heartbeat?: DeviceHeartbeat,
  ): Promise<RoomState>;
  state(url: string): Promise<RoomState>;
};

export type RedisHashResponse = Record<string, string> | string[] | null;

export type RedisSessionClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<"OK" | null>;
  setnx(key: string, value: string): Promise<number>;
  incr(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<RedisHashResponse>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
};

export type SessionStoreOptions = {
  now?: () => number;
  staleAfterMs?: number;
  ttlSeconds?: number;
};

export type SessionEnvironment = Readonly<{
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  [key: string]: string | undefined;
}>;

export function createMemorySessionStore(options: SessionStoreOptions = {}) {
  const registry = createSessionRegistry(options);

  return {
    kind: "memory" as const,
    async claim(url: string, deviceId: string) {
      return registry.claim(url, deviceId);
    },
    async heartbeat(
      url: string,
      deviceId: string,
      heartbeat: DeviceHeartbeat = {},
    ) {
      return registry.heartbeat(url, deviceId, heartbeat);
    },
    async state(url: string) {
      return registry.state(url);
    },
  } satisfies SessionStore;
}

export function createRedisSessionStore(
  redis: RedisSessionClient,
  options: SessionStoreOptions = {},
) {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const ttlSeconds =
    options.ttlSeconds ?? Math.max(60, Math.ceil((staleAfterMs * 4) / 1_000));

  return {
    kind: "redis" as const,
    async claim(url: string, deviceId: string) {
      const sessionKey = normalizeSessionKey(url);
      const keys = redisSessionKeys(sessionKey);
      const timestamp = now();

      await pruneRedisSession(redis, keys, timestamp, staleAfterMs, ttlSeconds);
      let hostDeviceId = await redis.get(keys.host);
      const previous = parseDevice(await redis.hget(keys.devices, deviceId));

      if (!hostDeviceId) {
        // Atomic claim: only SETNX can install a host. Never plain-SET as a
        // fallback — that's how two racing devices both became host. If the
        // key expires between SETNX and GET, retry rather than clobber.
        for (let attempt = 0; attempt < 3 && !hostDeviceId; attempt += 1) {
          const claimedHost = await redis.setnx(keys.host, deviceId);
          hostDeviceId =
            claimedHost === 1 ? deviceId : await redis.get(keys.host);
        }
        hostDeviceId ??= deviceId;
      }

      const device: RoomDevice = {
        ...previous,
        deviceId,
        joinedAt: previous?.joinedAt ?? timestamp,
        lastSeenAt: timestamp,
        role: hostDeviceId === deviceId ? "host" : "phone",
        sessionKey,
      };
      await writeRedisDevice(redis, keys, device);
      await touchRedisSession(redis, keys, timestamp, ttlSeconds);

      return claimFromDevice(device);
    },
    async heartbeat(
      url: string,
      deviceId: string,
      heartbeat: DeviceHeartbeat = {},
    ) {
      const claim = await this.claim(url, deviceId);
      const keys = redisSessionKeys(claim.sessionKey);
      const previous = parseDevice(await redis.hget(keys.devices, deviceId));
      const hostDeviceId = (await redis.get(keys.host)) ?? claim.deviceId;
      const mergedHeartbeat = mergeHeartbeat(previous, heartbeat);
      const timestamp = now();
      const device: RoomDevice = {
        ...previous,
        ...claim,
        ...mergedHeartbeat,
        lastSeenAt: timestamp,
        role: hostDeviceId === deviceId ? "host" : "phone",
      };

      await writeRedisDevice(redis, keys, device);
      await touchRedisSession(redis, keys, timestamp, ttlSeconds);
      return this.state(url);
    },
    async state(url: string) {
      const sessionKey = normalizeSessionKey(url);
      const keys = redisSessionKeys(sessionKey);
      const timestamp = now();

      await pruneRedisSession(redis, keys, timestamp, staleAfterMs, ttlSeconds);
      const hostDeviceId = (await redis.get(keys.host)) ?? "";
      const devices = (await readRedisDevices(redis, keys)).sort(
        compareDevicesForOutput,
      );
      const version = await readRedisVersion(redis, keys);

      return {
        sessionKey,
        hostDeviceId: devices.length === 0 ? "" : hostDeviceId,
        revision: version.revision,
        changedAt: version.changedAt,
        devices,
        calibrationTurn: selectRoomCalibrationTurn(devices, timestamp),
        timeSync: deriveRoomTimeSync(devices),
        ranges: deriveAcousticRanges(devices, { hostEpochNowMs: timestamp }),
        audioEvents: deriveReconciledAudioEvents(devices),
        updatedAt: timestamp,
      };
    },
  } satisfies SessionStore;
}

export function createResilientSessionStore(
  primary: SessionStore,
  fallback: SessionStore,
) {
  let usingFallback = false;

  async function run<T>(
    primaryOperation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
  ) {
    if (usingFallback) {
      return fallbackOperation();
    }

    try {
      return await primaryOperation();
    } catch {
      usingFallback = true;
      return fallbackOperation();
    }
  }

  return {
    get kind() {
      return usingFallback ? fallback.kind : primary.kind;
    },
    claim(url: string, deviceId: string) {
      return run(
        () => primary.claim(url, deviceId),
        () => fallback.claim(url, deviceId),
      );
    },
    heartbeat(
      url: string,
      deviceId: string,
      heartbeat: DeviceHeartbeat = {},
    ) {
      return run(
        () => primary.heartbeat(url, deviceId, heartbeat),
        () => fallback.heartbeat(url, deviceId, heartbeat),
      );
    },
    state(url: string) {
      return run(
        () => primary.state(url),
        () => fallback.state(url),
      );
    },
  } satisfies SessionStore;
}

export function createSessionStoreFromEnvironment(
  env: SessionEnvironment = process.env,
  options: SessionStoreOptions = {},
): SessionStore {
  const credentials = redisRestCredentials(env);
  if (credentials) {
    return createResilientSessionStore(
      createRedisSessionStore(
        createUpstashRestRedisClient({
          url: credentials.url,
          token: credentials.token,
        }),
        options,
      ),
      createMemorySessionStore(options),
    );
  }

  return createMemorySessionStore(options);
}

export function redisRestCredentials(env: SessionEnvironment = process.env) {
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return {
      url: env.KV_REST_API_URL,
      token: env.KV_REST_API_TOKEN,
      source: "vercel-marketplace-kv" as const,
    };
  }

  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
      source: "upstash-rest" as const,
    };
  }

  return null;
}

export function createUpstashRestRedisClient({
  url,
  token,
}: {
  url: string;
  token: string;
}): RedisSessionClient {
  const baseUrl = url.replace(/\/+$/, "");

  async function command<T>(args: Array<string | number>) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as
      | { result?: T; error?: string }
      | null;

    if (!response.ok || !body || body.error) {
      throw new Error(body?.error ?? `Redis command failed: ${response.status}`);
    }

    return body.result as T;
  }

  return {
    get(key: string) {
      return command<string | null>(["GET", key]);
    },
    set(key: string, value: string) {
      return command<"OK" | null>(["SET", key, value]);
    },
    setnx(key: string, value: string) {
      return command<number>(["SETNX", key, value]);
    },
    incr(key: string) {
      return command<number>(["INCR", key]);
    },
    del(...keys: string[]) {
      if (keys.length === 0) {
        return Promise.resolve(0);
      }
      return command<number>(["DEL", ...keys]);
    },
    hget(key: string, field: string) {
      return command<string | null>(["HGET", key, field]);
    },
    hset(key: string, field: string, value: string) {
      return command<number>(["HSET", key, field, value]);
    },
    hgetall(key: string) {
      return command<RedisHashResponse>(["HGETALL", key]);
    },
    hdel(key: string, ...fields: string[]) {
      if (fields.length === 0) {
        return Promise.resolve(0);
      }
      return command<number>(["HDEL", key, ...fields]);
    },
    expire(key: string, seconds: number) {
      return command<number>(["EXPIRE", key, seconds]);
    },
  };
}

function redisSessionKeys(sessionKey: string) {
  const id = createHash("sha256").update(sessionKey).digest("base64url");
  const prefix = `blackmagic:session:${id}`;
  return {
    host: `${prefix}:host`,
    devices: `${prefix}:devices`,
    revision: `${prefix}:revision`,
    changedAt: `${prefix}:changedAt`,
  };
}

async function pruneRedisSession(
  redis: RedisSessionClient,
  keys: ReturnType<typeof redisSessionKeys>,
  timestamp: number,
  staleAfterMs: number,
  ttlSeconds: number,
) {
  const devices = await readRedisDevices(redis, keys);
  const staleCandidates = devices.filter(
    (device) => timestamp - device.lastSeenAt > staleAfterMs,
  );
  let changed = false;

  // Re-read each stale candidate immediately before deleting: a device can
  // heartbeat between the bulk read and the delete, and pruning that fresh
  // record would ghost a live phone. The remaining one-round-trip window
  // self-heals on the device's next heartbeat.
  const confirmedStaleIds: string[] = [];
  const revivedDevices: RoomDevice[] = [];
  for (const candidate of staleCandidates) {
    const latest = parseDevice(
      await redis.hget(keys.devices, candidate.deviceId),
    );
    if (!latest || timestamp - latest.lastSeenAt > staleAfterMs) {
      confirmedStaleIds.push(candidate.deviceId);
    } else {
      revivedDevices.push(latest);
    }
  }

  if (confirmedStaleIds.length > 0) {
    await redis.hdel(keys.devices, ...confirmedStaleIds);
    changed = true;
  }

  const activeDevices = [
    ...devices.filter(
      (device) => timestamp - device.lastSeenAt <= staleAfterMs,
    ),
    ...revivedDevices,
  ];

  if (activeDevices.length === 0) {
    await redis.del(keys.host, keys.devices);
    if (devices.length > 0) {
      await touchRedisSession(redis, keys, timestamp, ttlSeconds);
    }
    return;
  }

  let hostDeviceId = await redis.get(keys.host);
  if (!hostDeviceId || !activeDevices.some((device) => device.deviceId === hostDeviceId)) {
    if (hostDeviceId) {
      await redis.del(keys.host);
      changed = true;
    }
    const [nextHost] = activeDevices.sort(compareDevicesByJoin);
    const claimedHost = await redis.setnx(keys.host, nextHost.deviceId);
    hostDeviceId =
      claimedHost === 1
        ? nextHost.deviceId
        : (await redis.get(keys.host)) ?? nextHost.deviceId;
    changed = true;
  }

  await Promise.all(
    activeDevices.map((device) => {
      const role = device.deviceId === hostDeviceId ? "host" : "phone";
      if (device.role === role) {
        return Promise.resolve();
      }
      changed = true;
      return writeRedisDevice(redis, keys, { ...device, role });
    }),
  );
  if (changed) {
    await touchRedisSession(redis, keys, timestamp, ttlSeconds);
    return;
  }
  await refreshRedisSessionTtl(redis, keys, ttlSeconds);
}

async function readRedisDevices(
  redis: RedisSessionClient,
  keys: ReturnType<typeof redisSessionKeys>,
) {
  const hash = normalizeRedisHash(await redis.hgetall(keys.devices));
  return Object.values(hash)
    .map(parseDevice)
    .filter((device): device is RoomDevice => device !== null);
}

function normalizeRedisHash(hash: RedisHashResponse): Record<string, string> {
  if (!hash) {
    return {};
  }

  if (!Array.isArray(hash)) {
    return hash;
  }

  const entries: Record<string, string> = {};
  for (let index = 0; index < hash.length; index += 2) {
    const field = hash[index];
    const value = hash[index + 1];
    if (typeof field === "string" && typeof value === "string") {
      entries[field] = value;
    }
  }
  return entries;
}

function parseDevice(raw: string | null): RoomDevice | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as RoomDevice;
    if (
      typeof parsed.deviceId !== "string" ||
      typeof parsed.sessionKey !== "string" ||
      typeof parsed.joinedAt !== "number" ||
      typeof parsed.lastSeenAt !== "number" ||
      (parsed.role !== "host" && parsed.role !== "phone")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeRedisDevice(
  redis: RedisSessionClient,
  keys: ReturnType<typeof redisSessionKeys>,
  device: RoomDevice,
) {
  return redis.hset(keys.devices, device.deviceId, JSON.stringify(device));
}

async function touchRedisSession(
  redis: RedisSessionClient,
  keys: ReturnType<typeof redisSessionKeys>,
  timestamp: number,
  ttlSeconds: number,
) {
  await redis.incr(keys.revision);
  await redis.set(keys.changedAt, String(timestamp));
  await refreshRedisSessionTtl(redis, keys, ttlSeconds);
}

async function readRedisVersion(
  redis: RedisSessionClient,
  keys: ReturnType<typeof redisSessionKeys>,
) {
  const [revision, changedAt] = await Promise.all([
    redis.get(keys.revision),
    redis.get(keys.changedAt),
  ]);

  return {
    revision: parseRedisNumber(revision),
    changedAt: parseRedisNumber(changedAt),
  };
}

async function refreshRedisSessionTtl(
  redis: RedisSessionClient,
  keys: ReturnType<typeof redisSessionKeys>,
  ttlSeconds: number,
) {
  await Promise.all([
    redis.expire(keys.host, ttlSeconds),
    redis.expire(keys.devices, ttlSeconds),
    redis.expire(keys.revision, ttlSeconds),
    redis.expire(keys.changedAt, ttlSeconds),
  ]);
}

function parseRedisNumber(value: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function claimFromDevice(device: RoomDevice): SessionClaim {
  return {
    deviceId: device.deviceId,
    joinedAt: device.joinedAt,
    lastSeenAt: device.lastSeenAt,
    role: device.role,
    sessionKey: device.sessionKey,
  };
}

function compareDevicesByJoin(a: RoomDevice, b: RoomDevice) {
  if (a.joinedAt !== b.joinedAt) {
    return a.joinedAt - b.joinedAt;
  }
  return a.deviceId.localeCompare(b.deviceId);
}

function compareDevicesForOutput(a: RoomDevice, b: RoomDevice) {
  if (a.role !== b.role) {
    return a.role === "host" ? -1 : 1;
  }
  return compareDevicesByJoin(a, b);
}
