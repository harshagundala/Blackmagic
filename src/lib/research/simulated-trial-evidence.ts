import {
  simulateAcousticRoom,
  type AcousticRoomSimulationOptions,
  type AcousticRoomSimulationResult,
} from "./acoustic-room-simulator";
import {
  createPhysicalRoomTrialEvidence,
  type PhysicalRoomTrialEvidence,
  type PhysicalRoomValidationSnapshot,
} from "./validation-trace";

export type SimulatedPhysicalRoomTrialEvidenceOptions = {
  baseUrl: string;
  generatedAtMs: number;
  requiredReadyStreakMs?: number;
  roomUrl: string;
  simulation?: Partial<
    Omit<AcousticRoomSimulationOptions, "roomUrl" | "devices" | "speechEvents">
  >;
};

export type SimulatedPhysicalRoomTrialEvidenceResult = {
  evidence: PhysicalRoomTrialEvidence;
  simulation: AcousticRoomSimulationResult;
  snapshots: PhysicalRoomValidationSnapshot[];
};

const DEFAULT_READY_STREAK_MS = 5_000;

export function createSimulatedPhysicalRoomTrialEvidence({
  baseUrl,
  generatedAtMs,
  requiredReadyStreakMs = DEFAULT_READY_STREAK_MS,
  roomUrl,
  simulation: simulationOptions = {},
}: SimulatedPhysicalRoomTrialEvidenceOptions): SimulatedPhysicalRoomTrialEvidenceResult {
  const simulation = simulateAcousticRoom({
    roomUrl,
    devices: [
      { deviceId: "host", x: 0, y: 0 },
      { deviceId: "phone-a", x: 2.2, y: 0.25 },
      { deviceId: "phone-b", x: 0.65, y: 2.15 },
    ],
    exchangesPerPair: 3,
    sampleNoiseStdDev: 0.08,
    speechEvents: [
      {
        id: "speaker-1",
        x: -0.5,
        y: -0.35,
        emittedAtHostEpochMs: 118_000,
      },
    ],
    voiceNoiseMs: 0.04,
    ...simulationOptions,
  });
  const firstCapturedAtMs = Math.max(0, generatedAtMs - requiredReadyStreakMs);
  const snapshots: PhysicalRoomValidationSnapshot[] = [
    snapshotFromSimulation(simulation, firstCapturedAtMs),
    snapshotFromSimulation(simulation, generatedAtMs),
  ];

  return {
    evidence: createPhysicalRoomTrialEvidence({
      baseUrl,
      generatedAtMs,
      requiredReadyStreakMs,
      sessionUrl: roomUrl,
      snapshots,
    }),
    simulation,
    snapshots,
  };
}

function snapshotFromSimulation(
  simulation: AcousticRoomSimulationResult,
  capturedAtMs: number,
): PhysicalRoomValidationSnapshot {
  return {
    capturedAtMs,
    sessionKey: simulation.roomState.sessionKey,
    revision: simulation.roomState.revision,
    updatedAt: simulation.roomState.updatedAt,
    validation: simulation.validation,
  };
}
