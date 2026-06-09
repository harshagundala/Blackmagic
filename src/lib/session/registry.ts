export type SessionRole = "host" | "phone";

export type SessionClaim = {
  deviceId: string;
  joinedAt: number;
  lastSeenAt: number;
  role: SessionRole;
  sessionKey: string;
};

export type SensorState = "idle" | "active" | "blocked";

export type DeviceHeartbeat = {
  micLevel?: number | null;
  sampleRate?: number | null;
  clockQuality?: number | null;
  clockUncertaintyMs?: number | null;
  motion?: SensorState;
  heading?: SensorState;
  location?: SensorState;
};

export type RoomDevice = SessionClaim & DeviceHeartbeat;

export type RoomState = {
  sessionKey: string;
  hostDeviceId: string;
  devices: RoomDevice[];
  updatedAt: number;
};

type SessionRecord = {
  hostDeviceId: string;
  claims: Map<string, RoomDevice>;
};

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;

export type SessionRegistryOptions = {
  now?: () => number;
  staleAfterMs?: number;
};

const DEFAULT_STALE_AFTER_MS = 12_000;

export function createSessionRegistry(options: SessionRegistryOptions = {}) {
  const sessions = new Map<string, SessionRecord>();
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return {
    claim(url: string, deviceId: string): SessionClaim {
      const sessionKey = normalizeSessionKey(url);
      const existing = sessions.get(sessionKey);
      const timestamp = now();

      if (!existing) {
        const claim = {
          deviceId,
          joinedAt: timestamp,
          lastSeenAt: timestamp,
          role: "host" as const,
          sessionKey,
        };
        sessions.set(sessionKey, {
          hostDeviceId: deviceId,
          claims: new Map([[deviceId, claim]]),
        });
        return claim;
      }

      const previous = existing.claims.get(deviceId);
      if (previous) {
        previous.lastSeenAt = timestamp;
        return previous;
      }

      const claim = {
        deviceId,
        joinedAt: timestamp,
        lastSeenAt: timestamp,
        role: existing.hostDeviceId === deviceId ? ("host" as const) : ("phone" as const),
        sessionKey,
      };
      existing.claims.set(deviceId, claim);
      return claim;
    },

    heartbeat(
      url: string,
      deviceId: string,
      heartbeat: DeviceHeartbeat = {},
    ): RoomState {
      const claim = this.claim(url, deviceId);
      const record = sessions.get(claim.sessionKey);
      if (!record) {
        throw new Error("Session record missing after claim.");
      }

      const current = record.claims.get(deviceId);
      if (!current) {
        throw new Error("Device claim missing after claim.");
      }

      Object.assign(current, sanitizeHeartbeat(heartbeat), {
        lastSeenAt: now(),
      });

      return this.state(url);
    },

    state(url: string): RoomState {
      const sessionKey = normalizeSessionKey(url);
      const record = sessions.get(sessionKey);
      const timestamp = now();

      if (!record) {
        return {
          sessionKey,
          hostDeviceId: "",
          devices: [],
          updatedAt: timestamp,
        };
      }

      for (const [deviceId, claim] of record.claims.entries()) {
        if (
          deviceId !== record.hostDeviceId &&
          timestamp - claim.lastSeenAt > staleAfterMs
        ) {
          record.claims.delete(deviceId);
        }
      }

      return {
        sessionKey,
        hostDeviceId: record.hostDeviceId,
        devices: [...record.claims.values()].sort(compareDevices),
        updatedAt: timestamp,
      };
    },
  };
}

export function normalizeSessionKey(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
}

function sanitizeHeartbeat(heartbeat: DeviceHeartbeat): DeviceHeartbeat {
  return {
    micLevel: clampNumber(heartbeat.micLevel, 0, 1),
    sampleRate: heartbeat.sampleRate ?? null,
    clockQuality: clampNumber(heartbeat.clockQuality, 0, 1),
    clockUncertaintyMs: heartbeat.clockUncertaintyMs ?? null,
    motion: heartbeat.motion,
    heading: heartbeat.heading,
    location: heartbeat.location,
  };
}

function clampNumber(value: number | null | undefined, min: number, max: number) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return value ?? null;
  }

  return Math.max(min, Math.min(max, value));
}

function compareDevices(a: RoomDevice, b: RoomDevice) {
  if (a.role !== b.role) {
    return a.role === "host" ? -1 : 1;
  }

  return a.joinedAt - b.joinedAt;
}
