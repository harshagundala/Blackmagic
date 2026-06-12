import { describe, expect, it } from "vitest";
import {
  HEALTHY_CAPTURE_RMS,
  QUIET_CAPTURE_REBUILD_MS,
  SILENT_CAPTURE_REBUILD_MS,
  SILENT_CAPTURE_RMS,
  captureRecoveryFuseMs,
  shouldAutoPromoteRawCapture,
} from "./capture-health";

describe("captureRecoveryFuseMs", () => {
  it("treats a healthy noise floor as no recovery needed", () => {
    expect(captureRecoveryFuseMs(HEALTHY_CAPTURE_RMS)).toBeNull();
    expect(captureRecoveryFuseMs(1e-3)).toBeNull();
    expect(captureRecoveryFuseMs(0.05)).toBeNull();
  });

  it("recovers digital near-silence on the short fuse", () => {
    expect(captureRecoveryFuseMs(0)).toBe(SILENT_CAPTURE_REBUILD_MS);
    expect(captureRecoveryFuseMs(SILENT_CAPTURE_RMS)).toBe(
      SILENT_CAPTURE_REBUILD_MS,
    );
  });

  it("recovers every sub-healthy level on the long fuse — no dead zone", () => {
    // Regression: a broken iOS capture path observed leaking ~5e-5 RMS sat
    // between the old 3e-5 quiet ceiling and the 1e-4 healthy floor, so the
    // watchdog never fired and the phone stayed deaf for the whole session.
    expect(captureRecoveryFuseMs(5e-5)).toBe(QUIET_CAPTURE_REBUILD_MS);
    expect(captureRecoveryFuseMs(2e-5)).toBe(QUIET_CAPTURE_REBUILD_MS);
    expect(captureRecoveryFuseMs(9.9e-5)).toBe(QUIET_CAPTURE_REBUILD_MS);
  });
});

describe("shouldAutoPromoteRawCapture", () => {
  const promotable = {
    mic: "active" as const,
    audioContextState: "running" as AudioContextState,
    captureMode: "processed" as const,
    rawCaptureVerified: false,
    roomDeviceCount: 2,
  };

  it("promotes a processed capture once a multi-device room is live", () => {
    expect(shouldAutoPromoteRawCapture(promotable)).toBe(true);
  });

  it("stays put while alone in the room", () => {
    expect(
      shouldAutoPromoteRawCapture({ ...promotable, roomDeviceCount: 1 }),
    ).toBe(false);
  });

  it("stays put when capture is not live yet", () => {
    expect(shouldAutoPromoteRawCapture({ ...promotable, mic: "idle" })).toBe(
      false,
    );
    expect(
      shouldAutoPromoteRawCapture({
        ...promotable,
        audioContextState: "suspended",
      }),
    ).toBe(false);
  });

  it("stays put when already on raw or video capture", () => {
    expect(
      shouldAutoPromoteRawCapture({ ...promotable, captureMode: "raw" }),
    ).toBe(false);
    expect(
      shouldAutoPromoteRawCapture({ ...promotable, captureMode: "video" }),
    ).toBe(false);
    expect(
      shouldAutoPromoteRawCapture({ ...promotable, rawCaptureVerified: true }),
    ).toBe(false);
  });
});
