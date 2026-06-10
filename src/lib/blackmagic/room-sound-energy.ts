export type RoomSoundEnergyDevice = {
  micLevel?: number | null;
};

export type RoomSoundEnergySource = {
  confidence?: number | null;
  ageMs?: number | null;
};

export type RoomSoundEnergyInput = {
  localMicLevel: number;
  devices: RoomSoundEnergyDevice[];
  audioSources: RoomSoundEnergySource[];
};

export function roomSoundEnergy({
  localMicLevel,
  devices,
  audioSources,
}: RoomSoundEnergyInput) {
  const micEnergy = microphoneEnergyFor(
    Math.max(
      sanitizeLevel(localMicLevel),
      ...devices.map((device) => sanitizeLevel(device.micLevel)),
    ),
  );
  const sourceEnergy = Math.max(0, ...audioSources.map(sourceEnergyFor));

  return clamp(Math.max(micEnergy, sourceEnergy), 0, 1);
}

// Raw capture (AGC off) on a quiet iPhone idles around 0.001-0.004 RMS;
// subtracting the floor keeps the surface still in silence so speech motion
// reads against a calm baseline instead of a permanent glow.
const MIC_NOISE_FLOOR_RMS = 0.004;

function microphoneEnergyFor(level: number) {
  // iPhone Safari often reports ordinary nearby speech at low RMS levels
  // (~0.01-0.03). Use a saturating visual curve so speech visibly breathes
  // without making low room noise dominate the surface.
  return 1 - Math.exp(-Math.max(0, level - MIC_NOISE_FLOOR_RMS) * 90);
}

function sourceEnergyFor(source: RoomSoundEnergySource) {
  const confidence = clamp(sanitizeLevel(source.confidence), 0, 1);
  const ageMs =
    typeof source.ageMs === "number" && Number.isFinite(source.ageMs)
      ? Math.max(0, source.ageMs)
      : 0;
  const freshness = clamp(1 - ageMs / 4_000, 0, 1);

  return confidence * freshness * 0.9;
}

function sanitizeLevel(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
