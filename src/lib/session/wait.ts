import type { RoomState } from "./registry";
import type { SessionStore } from "./store";

export type RoomStateWaitOptions = {
  afterRevision: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 4_500;
const DEFAULT_POLL_INTERVAL_MS = 180;

export async function waitForRoomStateRevision(
  store: SessionStore,
  url: string,
  {
    afterRevision,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
    sleep = sleepFor,
  }: RoomStateWaitOptions,
): Promise<RoomState> {
  const startedAt = now();
  let latest = await store.state(url);

  while (latest.revision <= afterRevision) {
    if (now() - startedAt >= timeoutMs) {
      return latest;
    }

    await sleep(Math.max(1, Math.min(pollIntervalMs, timeoutMs)));
    latest = await store.state(url);
  }

  return latest;
}

function sleepFor(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
