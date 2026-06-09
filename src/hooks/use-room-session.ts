"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SensorSnapshot } from "@/hooks/use-sensor-suite";
import type { RoomState, SessionRole } from "@/lib/session/registry";

type SessionClaimResponse = {
  role: SessionRole;
  sessionKey: string;
};

type RoomSession = {
  deviceId: string;
  role: SessionRole | null;
  roomState: RoomState | null;
  claimReady: boolean;
  heartbeat: (snapshot: SensorSnapshot) => Promise<void>;
};

export function useRoomSession(): RoomSession {
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);
  const [role, setRole] = useState<SessionRole | null>(null);
  const [sessionKey, setSessionKey] = useState("");
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const urlRef = useRef("");

  useEffect(() => {
    urlRef.current = window.location.href;
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
  }, [deviceId]);

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
    setRoomState(state);
  }, []);

  useEffect(() => {
    void pollState();
    const timer = window.setInterval(() => void pollState(), 2_000);
    return () => window.clearInterval(timer);
  }, [pollState, sessionKey]);

  const heartbeat = useCallback(
    async (snapshot: SensorSnapshot) => {
      if (!urlRef.current) {
        return;
      }

      const response = await fetch("/api/session/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId,
          url: urlRef.current,
          heartbeat: {
            mic: snapshot.mic,
            micLevel: snapshot.micLevel,
            sampleRate: snapshot.sampleRate,
            clockQuality: snapshot.clock?.quality ?? null,
            clockUncertaintyMs: snapshot.clock?.uncertaintyMs ?? null,
            audioFrame: snapshot.audioFrame,
            motion: snapshot.motion,
            heading: snapshot.heading,
            location: snapshot.location,
          },
        }),
      });
      if (response.ok) {
        setRoomState((await response.json()) as RoomState);
      }
    },
    [deviceId],
  );

  return {
    deviceId,
    role,
    roomState,
    claimReady: role !== null,
    heartbeat,
  };
}

function getOrCreateDeviceId() {
  if (typeof window === "undefined") {
    return "server";
  }

  const key = "blackmagic.device";
  const existing = window.localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  window.localStorage.setItem(key, next);
  return next;
}
