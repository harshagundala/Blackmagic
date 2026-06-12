"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SensorSnapshot } from "@/hooks/use-sensor-suite";
import type {
  DeviceHeartbeat,
  RoomState,
  SessionRole,
} from "@/lib/session/registry";
import {
  acknowledgedVoiceEventId,
  createDeviceHeartbeatPayload,
} from "@/lib/session/heartbeat-payload";
import { IDLE_ROOM_POLL_INTERVAL_MS } from "@/lib/session/polling";

type SessionClaimResponse = {
  role: SessionRole;
  sessionKey: string;
};

export type RoomConnectionState = "connecting" | "live" | "reconnecting";

type RoomSession = {
  deviceId: string;
  role: SessionRole | null;
  roomState: RoomState | null;
  claimReady: boolean;
  connection: RoomConnectionState;
  // Resolves true only when the server acknowledged the heartbeat; calibration
  // emitters use this to confirm a pulse advertisement landed before playing.
  heartbeat: (
    snapshot: SensorSnapshot,
    calibration?: Pick<
      DeviceHeartbeat,
      "acousticPulse" | "acousticObservation"
    >,
  ) => Promise<boolean>;
};

export type RoomSessionOptions = {
  pollIntervalMs?: number;
  // Joining is a mutation: the first claimer becomes the room's host and
  // clock reference. A page that was merely opened must NOT claim — a
  // lurking pre-tap tab that wins the host role has no capture running and
  // strands every real phone's clock sync. Pass false until the user
  // actually begins; reads (room state polling) stay available throughout.
  join?: boolean;
};

export function useRoomSession({
  pollIntervalMs = IDLE_ROOM_POLL_INTERVAL_MS,
  join = true,
}: RoomSessionOptions = {}): RoomSession {
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);
  const [role, setRole] = useState<SessionRole | null>(null);
  const [sessionKey, setSessionKey] = useState("");
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [connection, setConnection] =
    useState<RoomConnectionState>("connecting");
  const urlRef = useRef("");
  const roomRevisionRef = useRef(0);
  const publishedVoiceEventIdRef = useRef("");

  useEffect(() => {
    urlRef.current = window.location.href;
    if (!join) {
      return;
    }
    let cancelled = false;

    async function claim() {
      const response = await fetch("/api/session/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId,
          url: urlRef.current,
        }),
      });
      const data = (await response.json()) as SessionClaimResponse;
      if (!cancelled) {
        setRole(data.role);
        setSessionKey(data.sessionKey);
      }
    }

    void claim();
    return () => {
      cancelled = true;
    };
  }, [deviceId, join]);

  const applyRoomState = useCallback((state: RoomState) => {
    const revision =
      typeof state.revision === "number" && Number.isFinite(state.revision)
        ? state.revision
        : roomRevisionRef.current;
    roomRevisionRef.current = Math.max(roomRevisionRef.current, revision);
    setRoomState(state);
  }, []);

  const pollState = useCallback(async () => {
    if (!urlRef.current) {
      return;
    }

    const params = new URLSearchParams({ url: urlRef.current });
    const response = await fetch(`/api/session/state?${params.toString()}`);
    if (!response.ok) {
      return;
    }
    const state = (await response.json()) as RoomState;
    applyRoomState(state);
  }, [applyRoomState]);

  // One transport loop: the long-poll wait endpoint both pushes changes and,
  // on its server-side timeout, acts as the periodic refresh — running an
  // interval poll alongside it only doubled traffic. Errors back off
  // exponentially and surface as a connection state instead of being silent.
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    let failureCount = 0;

    async function waitForChanges() {
      // Fast first paint before the long-poll settles in.
      await pollState().catch(() => undefined);

      while (!cancelled) {
        if (!urlRef.current) {
          await sleep(250);
          continue;
        }

        const params = new URLSearchParams({
          url: urlRef.current,
          revision: String(roomRevisionRef.current),
          timeoutMs: "4500",
        });
        controller = new AbortController();

        try {
          const response = await fetch(
            `/api/session/wait?${params.toString()}`,
            {
              cache: "no-store",
              signal: controller.signal,
            },
          );
          if (response.ok) {
            applyRoomState((await response.json()) as RoomState);
            failureCount = 0;
            setConnection("live");
            continue;
          }
        } catch {
          if (cancelled) {
            return;
          }
        }

        failureCount += 1;
        setConnection(failureCount >= 2 ? "reconnecting" : "live");
        const backoffMs = Math.min(
          5_000,
          Math.min(1_000, pollIntervalMs) * 2 ** Math.min(4, failureCount - 1),
        );
        await sleep(backoffMs);
      }
    }

    void waitForChanges();
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [applyRoomState, pollIntervalMs, pollState, sessionKey]);

  // iOS Safari freezes timers and sockets while the tab is hidden. On return,
  // resync immediately instead of waiting for the next long-poll cycle.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void pollState().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [pollState]);

  const heartbeat = useCallback(
    async (
      snapshot: SensorSnapshot,
      calibration: Pick<
        DeviceHeartbeat,
        "acousticPulse" | "acousticObservation"
      > = {},
    ) => {
      if (!urlRef.current) {
        return false;
      }

      const heartbeatPayload = createDeviceHeartbeatPayload({
        snapshot,
        calibration,
        lastPublishedVoiceEventId: publishedVoiceEventIdRef.current,
      });

      const response = await fetch("/api/session/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId,
          url: urlRef.current,
          responseMode: "ack",
          heartbeat: heartbeatPayload,
        }),
      }).catch(() => null);
      if (response?.ok) {
        const payload = (await response.json().catch(() => null)) as unknown;
        if (isRoomState(payload)) {
          applyRoomState(payload);
          publishedVoiceEventIdRef.current = acknowledgedVoiceEventId(
            heartbeatPayload,
            publishedVoiceEventIdRef.current,
          );
          return true;
        }
        publishedVoiceEventIdRef.current = acknowledgedVoiceEventId(
          heartbeatPayload,
          publishedVoiceEventIdRef.current,
        );
        return true;
      }
      return false;
    },
    [applyRoomState, deviceId],
  );

  return {
    deviceId,
    role,
    roomState,
    claimReady: role !== null,
    connection,
    heartbeat,
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function isRoomState(value: unknown): value is RoomState {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Partial<RoomState>).devices) &&
    Array.isArray((value as Partial<RoomState>).ranges) &&
    typeof (value as Partial<RoomState>).revision === "number"
  );
}

// Per-TAB identity (sessionStorage), not per-browser (localStorage): the
// device id keys the realtime signal inbox and the room membership, so two
// tabs sharing one id steal each other's WebRTC offers/answers and corrupt
// the room. A reload keeps its tab's id (sessionStorage survives reload), so
// identity stays stable where it matters; a genuinely new tab is honestly a
// new device that joins on its own.
function getOrCreateDeviceId() {
  if (typeof window === "undefined") {
    return "server";
  }

  const key = "blackmagic.device";
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) {
      return existing;
    }
    const next = crypto.randomUUID();
    window.sessionStorage.setItem(key, next);
    return next;
  } catch {
    // Storage unavailable (private mode quirks): a volatile id still works
    // for the life of the page.
    return crypto.randomUUID();
  }
}
