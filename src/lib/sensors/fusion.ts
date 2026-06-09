export type MotionVectorReading = {
  x?: number | null;
  y?: number | null;
  z?: number | null;
};

export type MotionRotationReading = {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
};

export type MotionReading = {
  acceleration?: MotionVectorReading | null;
  accelerationIncludingGravity?: MotionVectorReading | null;
  rotationRate?: MotionRotationReading | null;
  interval?: number | null;
  intervalMs?: number | null;
  capturedAtClientPerfMs?: number | null;
};

export type MotionSensorMetadata = {
  motionAccelerationX: number | null;
  motionAccelerationY: number | null;
  motionAccelerationZ: number | null;
  motionAccelerationIncludingGravityX: number | null;
  motionAccelerationIncludingGravityY: number | null;
  motionAccelerationIncludingGravityZ: number | null;
  motionAccelerationMagnitude: number | null;
  motionRotationAlpha: number | null;
  motionRotationBeta: number | null;
  motionRotationGamma: number | null;
  motionRotationRateDegPerSec: number | null;
  motionIntervalMs: number | null;
  motionCapturedAtClientPerfMs: number | null;
  motionStability: number | null;
};

const EARTH_GRAVITY_MPS2 = 9.80665;

export const idleMotionMetadata: MotionSensorMetadata = {
  motionAccelerationX: null,
  motionAccelerationY: null,
  motionAccelerationZ: null,
  motionAccelerationIncludingGravityX: null,
  motionAccelerationIncludingGravityY: null,
  motionAccelerationIncludingGravityZ: null,
  motionAccelerationMagnitude: null,
  motionRotationAlpha: null,
  motionRotationBeta: null,
  motionRotationGamma: null,
  motionRotationRateDegPerSec: null,
  motionIntervalMs: null,
  motionCapturedAtClientPerfMs: null,
  motionStability: null,
};

export function motionMetadataFromReading(
  reading: MotionReading,
): MotionSensorMetadata {
  const acceleration = vectorFrom(reading.acceleration);
  const accelerationIncludingGravity = vectorFrom(
    reading.accelerationIncludingGravity,
  );
  const rotation = rotationFrom(reading.rotationRate);
  const accelerationMagnitude = dynamicAccelerationMagnitude(
    acceleration,
    accelerationIncludingGravity,
  );
  const rotationMagnitude = magnitude(
    rotation === null
      ? null
      : { x: rotation.alpha, y: rotation.beta, z: rotation.gamma },
  );

  return {
    motionAccelerationX: acceleration?.x ?? null,
    motionAccelerationY: acceleration?.y ?? null,
    motionAccelerationZ: acceleration?.z ?? null,
    motionAccelerationIncludingGravityX: accelerationIncludingGravity?.x ?? null,
    motionAccelerationIncludingGravityY: accelerationIncludingGravity?.y ?? null,
    motionAccelerationIncludingGravityZ: accelerationIncludingGravity?.z ?? null,
    motionAccelerationMagnitude: accelerationMagnitude,
    motionRotationAlpha: rotation?.alpha ?? null,
    motionRotationBeta: rotation?.beta ?? null,
    motionRotationGamma: rotation?.gamma ?? null,
    motionRotationRateDegPerSec: rotationMagnitude,
    motionIntervalMs: nonNegative(reading.intervalMs ?? reading.interval),
    motionCapturedAtClientPerfMs: nonNegative(reading.capturedAtClientPerfMs),
    motionStability: estimateMotionStability({
      accelerationMagnitude,
      rotationRateDegPerSec: rotationMagnitude,
    }),
  };
}

export function estimateMotionStability({
  accelerationMagnitude,
  rotationRateDegPerSec,
}: {
  accelerationMagnitude: number | null | undefined;
  rotationRateDegPerSec: number | null | undefined;
}) {
  const hasAcceleration = finite(accelerationMagnitude) !== null;
  const hasRotation = finite(rotationRateDegPerSec) !== null;
  if (!hasAcceleration && !hasRotation) {
    return null;
  }

  const accelerationScore = hasAcceleration
    ? 1 / (1 + Math.max(0, accelerationMagnitude ?? 0) / 1.2)
    : 1;
  const rotationScore = hasRotation
    ? 1 / (1 + Math.max(0, rotationRateDegPerSec ?? 0) / 45)
    : 1;

  return round(clamp(accelerationScore * rotationScore, 0, 1));
}

function vectorFrom(reading: MotionVectorReading | null | undefined) {
  const x = finite(reading?.x);
  const y = finite(reading?.y);
  const z = finite(reading?.z);
  if (x === null && y === null && z === null) {
    return null;
  }

  return {
    x: x ?? 0,
    y: y ?? 0,
    z: z ?? 0,
  };
}

function rotationFrom(reading: MotionRotationReading | null | undefined) {
  const alpha = finite(reading?.alpha);
  const beta = finite(reading?.beta);
  const gamma = finite(reading?.gamma);
  if (alpha === null && beta === null && gamma === null) {
    return null;
  }

  return {
    alpha: alpha ?? 0,
    beta: beta ?? 0,
    gamma: gamma ?? 0,
  };
}

function dynamicAccelerationMagnitude(
  acceleration: MotionVectorReading | null,
  accelerationIncludingGravity: MotionVectorReading | null,
) {
  const direct = magnitude(acceleration);
  if (direct !== null) {
    return direct;
  }

  const withGravity = magnitude(accelerationIncludingGravity);
  if (withGravity === null) {
    return null;
  }

  return round(Math.max(0, Math.abs(withGravity - EARTH_GRAVITY_MPS2)));
}

function magnitude(vector: MotionVectorReading | null) {
  if (!vector) {
    return null;
  }

  return round(
    Math.hypot(
      finite(vector.x) ?? 0,
      finite(vector.y) ?? 0,
      finite(vector.z) ?? 0,
    ),
  );
}

function nonNegative(value: number | null | undefined) {
  const finiteValue = finite(value);
  return finiteValue === null ? null : Math.max(0, finiteValue);
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number) {
  return Number(value.toFixed(3));
}
