import { describe, expect, test } from "vitest";
import { createPhoneMarkers, formatDistanceLabel } from "./phone-markers";

describe("blackmagic phone markers", () => {
  test("formats acoustic range estimates as compact meter labels", () => {
    expect(formatDistanceLabel(0.84)).toBe("0.84m");
    expect(formatDistanceLabel(2.36)).toBe("2.4m");
    expect(formatDistanceLabel(12.4)).toBe("12m");
  });

  test("only exposes distance labels for localized acoustic ranges", () => {
    const markers = createPhoneMarkers([
      {
        deviceId: "phone-a",
        x: 1.2,
        y: -0.4,
        confidence: 0.82,
        distanceMeters: 2.36,
        localized: true,
      },
      {
        deviceId: "phone-b",
        x: 0,
        y: 0,
        confidence: 0.12,
        distanceMeters: null,
        localized: false,
      },
    ]);

    expect(markers[0]).toEqual(
      expect.objectContaining({
        id: "phone-a",
        distanceLabel: "2.4m",
        localized: true,
      }),
    );
    expect(markers[0].xPx).toBeGreaterThan(0);
    expect(markers[1]).toEqual(
      expect.objectContaining({
        id: "phone-b",
        distanceLabel: null,
        localized: false,
      }),
    );
  });
});
