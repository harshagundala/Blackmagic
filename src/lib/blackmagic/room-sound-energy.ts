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
  const micEnergy =
    Math.max(
      sanitizeLevel(localMicLevel),
      ...devices.map((device) => sanitizeLevel(device.micLevel)),
    ) * 18;
  const sourceEnergy = Math.max(0, ...audioSources.map(sourceEnergyFor));

  return clamp(Math.max(micEnergy, sourceEnergy), 0, 1);
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
