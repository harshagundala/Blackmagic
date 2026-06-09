export type SessionRole = "host" | "phone";

export type SessionClaim = {
  deviceId: string;
  joinedAt: number;
  role: SessionRole;
  sessionKey: string;
};

type SessionRecord = {
  hostDeviceId: string;
  claims: Map<string, SessionClaim>;
};

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;

export function createSessionRegistry() {
  const sessions = new Map<string, SessionRecord>();

  return {
    claim(url: string, deviceId: string): SessionClaim {
      const sessionKey = normalizeSessionKey(url);
      const existing = sessions.get(sessionKey);

      if (!existing) {
        const claim = {
          deviceId,
          joinedAt: Date.now(),
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
        return previous;
      }

      const claim = {
        deviceId,
        joinedAt: Date.now(),
        role: existing.hostDeviceId === deviceId ? ("host" as const) : ("phone" as const),
        sessionKey,
      };
      existing.claims.set(deviceId, claim);
      return claim;
    },
  };
}

export function normalizeSessionKey(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
}
