export type CalibrationEventType = "pulse" | "observation";

export function calibrationEventKey(
  type: CalibrationEventType,
  id: string,
) {
  return `${type}:${id}`;
}

export function shouldFlushCalibrationEvent(
  lastFlushedKey: string,
  nextKey: string,
) {
  return nextKey.length > 0 && nextKey !== lastFlushedKey;
}
