export type PhoneMarkerDevice = {
  deviceId: string;
  x: number;
  y: number;
  distanceMeters: number | null;
  confidence: number;
  coarse?: boolean;
  localized: boolean;
};

export type PhoneMarker = {
  id: string;
  xPx: number;
  yPx: number;
  scale: number;
  opacity: number;
  rotationDeg: number;
  distanceLabel: string | null;
  coarse: boolean;
  localized: boolean;
};

type PhoneMarkerOptions = {
  scalePxPerMeter?: number;
  maxX?: number;
  maxY?: number;
};

export function createPhoneMarkers(
  devices: PhoneMarkerDevice[],
  options: PhoneMarkerOptions = {},
): PhoneMarker[] {
  const scalePxPerMeter = options.scalePxPerMeter ?? 72;
  const maxX = options.maxX ?? 150;
  const maxY = options.maxY ?? 224;

  return devices.map((device, index) => {
    const confidence = clamp(device.confidence, 0, 1);
    const parked = parkedPeerPosition(index);
    const positioned = device.localized || device.coarse === true;
    const xPx = positioned
      ? clamp(device.x * scalePxPerMeter, -maxX, maxX)
      : parked.x;
    const yPx = positioned
      ? clamp(device.y * scalePxPerMeter, -maxY, maxY)
      : parked.y;
    const scale = device.localized
      ? 0.9 + confidence * 0.18
      : device.coarse
        ? 0.78 + confidence * 0.12
        : 0.82;
    // Pre-localization markers must still read against the white canvas —
    // they are the only visible signal that the ranging process is underway.
    const opacity = device.localized
      ? 0.54 + confidence * 0.42
      : device.coarse
        ? 0.52 + confidence * 0.28
        : 0.42;

    return {
      id: device.deviceId,
      xPx: round(xPx, 1),
      yPx: round(yPx, 1),
      scale: round(scale, 3),
      opacity: round(opacity, 3),
      rotationDeg: round(positioned ? clamp(device.x * 3, -8, 8) : 0, 1),
      distanceLabel:
        device.localized && device.distanceMeters !== null
          ? formatDistanceLabel(device.distanceMeters)
          : null,
      coarse: device.coarse === true,
      localized: device.localized,
    };
  });
}

export function formatDistanceLabel(meters: number) {
  if (!Number.isFinite(meters) || meters < 0) {
    return null;
  }

  if (meters < 1) {
    return `${meters.toFixed(2)}m`;
  }

  if (meters < 10) {
    return `${meters.toFixed(1)}m`;
  }

  return `${Math.round(meters)}m`;
}

function parkedPeerPosition(index: number) {
  const slot = index % 5;
  const row = Math.floor(index / 5);
  return {
    x: (slot - 2) * 28,
    y: 212 + row * 16,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}
