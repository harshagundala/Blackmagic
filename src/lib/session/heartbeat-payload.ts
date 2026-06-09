import type { SensorSnapshot } from "@/hooks/use-sensor-suite";
import type { DeviceHeartbeat } from "./registry";

export type HeartbeatPayloadInput = {
  snapshot: SensorSnapshot;
  calibration: Pick<
    DeviceHeartbeat,
    "acousticPulse" | "acousticObservation"
  >;
  lastPublishedVoiceEventId: string;
};

export function createDeviceHeartbeatPayload({
  snapshot,
  calibration,
  lastPublishedVoiceEventId,
}: HeartbeatPayloadInput): DeviceHeartbeat {
  const voiceEvent =
    snapshot.voiceEvent?.id &&
    snapshot.voiceEvent.id !== lastPublishedVoiceEventId
      ? snapshot.voiceEvent
      : null;

  return {
    mic: snapshot.mic,
    micLevel: snapshot.micLevel,
    sampleRate: snapshot.sampleRate,
    captureProcessing: snapshot.captureProcessing,
    audioContextState: snapshot.audioContextState,
    clockQuality: snapshot.clock?.quality ?? null,
    clockOffsetMs: snapshot.clock?.offsetMs ?? null,
    clockUncertaintyMs: snapshot.clock?.uncertaintyMs ?? null,
    clockMaxErrorMs: snapshot.clock?.maxErrorMs ?? null,
    clockBestRoundTripMs: snapshot.clock?.bestRoundTripMs ?? null,
    clockJitterMs: snapshot.clock?.jitterMs ?? null,
    clockSamplesUsed: snapshot.clock?.samplesUsed ?? null,
    clockOutliersRejected: snapshot.clock?.outliersRejected ?? null,
    clockOffsetStabilityMs: snapshot.clock?.offsetStabilityMs ?? null,
    audioFrame: snapshot.audioFrame,
    voiceEvent,
    acousticPulse: calibration.acousticPulse ?? null,
    acousticObservation: calibration.acousticObservation ?? null,
    motion: snapshot.motion,
    motionAccelerationX: snapshot.motionAccelerationX,
    motionAccelerationY: snapshot.motionAccelerationY,
    motionAccelerationZ: snapshot.motionAccelerationZ,
    motionAccelerationIncludingGravityX:
      snapshot.motionAccelerationIncludingGravityX,
    motionAccelerationIncludingGravityY:
      snapshot.motionAccelerationIncludingGravityY,
    motionAccelerationIncludingGravityZ:
      snapshot.motionAccelerationIncludingGravityZ,
    motionAccelerationMagnitude: snapshot.motionAccelerationMagnitude,
    motionRotationAlpha: snapshot.motionRotationAlpha,
    motionRotationBeta: snapshot.motionRotationBeta,
    motionRotationGamma: snapshot.motionRotationGamma,
    motionRotationRateDegPerSec: snapshot.motionRotationRateDegPerSec,
    motionIntervalMs: snapshot.motionIntervalMs,
    motionCapturedAtClientPerfMs: snapshot.motionCapturedAtClientPerfMs,
    motionStability: snapshot.motionStability,
    heading: snapshot.heading,
    headingDegrees: snapshot.headingDegrees,
    orientationBetaDegrees: snapshot.orientationBetaDegrees,
    orientationGammaDegrees: snapshot.orientationGammaDegrees,
    orientationAbsolute: snapshot.orientationAbsolute,
    location: snapshot.location,
    locationLatitude: snapshot.locationLatitude,
    locationLongitude: snapshot.locationLongitude,
    locationAccuracyMeters: snapshot.locationAccuracyMeters,
    locationAltitudeMeters: snapshot.locationAltitudeMeters,
    locationAltitudeAccuracyMeters: snapshot.locationAltitudeAccuracyMeters,
    locationHeadingDegrees: snapshot.locationHeadingDegrees,
    locationSpeedMetersPerSecond: snapshot.locationSpeedMetersPerSecond,
    locationCapturedAtEpochMs: snapshot.locationCapturedAtEpochMs,
  };
}

export function acknowledgedVoiceEventId(
  heartbeat: DeviceHeartbeat,
  current: string,
) {
  return heartbeat.voiceEvent?.id ?? current;
}
