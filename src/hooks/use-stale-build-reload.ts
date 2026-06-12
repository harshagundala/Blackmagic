"use client";

import { useEffect, useRef } from "react";

const CHECK_INTERVAL_MS = 60_000;
// Reload at most once per server build id, so a CDN still serving the old
// bundle cannot put the page into a reload loop.
const RELOAD_GUARD_KEY = "blackmagic.reloadedForBuild";

// Stale-tab self-healing: phones keep the page open across deploys, and a
// room with mixed bundle versions breaks in silent ways (mismatched chirp
// parameters, divergent thresholds — multiple field sessions were lost to
// exactly this). Each bundle carries its build id; when the server reports a
// different one, this tab is from a previous deploy and reloads itself as
// soon as it is not in the middle of a recording.
export function useStaleBuildReload({ holdReload }: { holdReload: boolean }) {
  const holdRef = useRef(holdReload);
  const pendingReloadRef = useRef(false);

  useEffect(() => {
    holdRef.current = holdReload;
    if (!holdReload && pendingReloadRef.current) {
      window.location.reload();
    }
  }, [holdReload]);

  useEffect(() => {
    const ownBuildId = process.env.NEXT_PUBLIC_BUILD_ID;
    if (!ownBuildId) {
      return;
    }

    const check = async () => {
      try {
        const response = await fetch("/api/build", { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as { buildId?: string };
        if (!body.buildId || body.buildId === ownBuildId) {
          return;
        }
        let alreadyReloaded = false;
        try {
          alreadyReloaded =
            window.sessionStorage.getItem(RELOAD_GUARD_KEY) === body.buildId;
          if (!alreadyReloaded) {
            window.sessionStorage.setItem(RELOAD_GUARD_KEY, body.buildId);
          }
        } catch {
          // Storage unavailable: fall through and reload once per page life.
          alreadyReloaded = pendingReloadRef.current;
        }
        if (alreadyReloaded) {
          return;
        }
        if (holdRef.current) {
          // Mid-recording: reload the moment the take finishes instead.
          pendingReloadRef.current = true;
          return;
        }
        window.location.reload();
      } catch {
        // Offline or transient failure: try again next tick.
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
