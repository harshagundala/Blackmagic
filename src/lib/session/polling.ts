export const IDLE_ROOM_POLL_INTERVAL_MS = 2_000;
export const ACTIVE_ROOM_POLL_INTERVAL_MS = 650;

export function roomStatePollingIntervalMs({
  listening,
}: {
  listening: boolean;
}) {
  return listening ? ACTIVE_ROOM_POLL_INTERVAL_MS : IDLE_ROOM_POLL_INTERVAL_MS;
}
