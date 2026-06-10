export type CalibrationEventType = "pulse" | "observation";

export type PulseWithHostTime = {
  emittedAtHostEpochMs: number;
};

export function calibrationEventKey(type: CalibrationEventType, id: string) {
  return `${type}:${id}`;
}

export function shouldFlushCalibrationEvent(
  lastFlushedKey: string,
  nextKey: string,
) {
  return nextKey.length > 0 && nextKey !== lastFlushedKey;
}

export function hasPulseLead(
  pulse: PulseWithHostTime,
  hostEpochNowMs: number,
  minLeadMs: number,
) {
  if (
    !Number.isFinite(pulse.emittedAtHostEpochMs) ||
    !Number.isFinite(hostEpochNowMs) ||
    !Number.isFinite(minLeadMs)
  ) {
    return false;
  }

  return pulse.emittedAtHostEpochMs - hostEpochNowMs >= Math.max(0, minLeadMs);
}
