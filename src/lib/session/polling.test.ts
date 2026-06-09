import { describe, expect, test } from "vitest";
import {
  ACTIVE_ROOM_POLL_INTERVAL_MS,
  IDLE_ROOM_POLL_INTERVAL_MS,
  roomStatePollingIntervalMs,
} from "./polling";

describe("room state polling cadence", () => {
  test("polls slowly before sensors are active", () => {
    expect(roomStatePollingIntervalMs({ listening: false })).toBe(
      IDLE_ROOM_POLL_INTERVAL_MS,
    );
  });

  test("polls faster while actively listening for peer calibration events", () => {
    expect(roomStatePollingIntervalMs({ listening: true })).toBe(
      ACTIVE_ROOM_POLL_INTERVAL_MS,
    );
    expect(ACTIVE_ROOM_POLL_INTERVAL_MS).toBeLessThan(
      IDLE_ROOM_POLL_INTERVAL_MS,
    );
  });
});
