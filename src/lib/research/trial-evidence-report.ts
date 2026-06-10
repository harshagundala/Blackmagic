import type {
  PhysicalRoomTrialEvidence,
  PhysicalRoomTrialEvidenceGate,
} from "./validation-trace";

export function formatPhysicalRoomTrialEvidenceReport(
  evidence: PhysicalRoomTrialEvidence,
) {
  const lines = [
    `BLACKMAGIC FIELD TRIAL: ${evidence.passed ? "PASS" : "FAIL"}`,
    `Session: ${evidence.sessionUrl}`,
    `Generated: ${new Date(evidence.generatedAtMs).toISOString()}`,
    `Samples: ${evidence.sampleWindow.sampleCount} over ${evidence.sampleWindow.durationMs} ms`,
    `Status: ${evidence.summary.status}`,
    `Failed gates: ${
      evidence.failedGateIds.length === 0
        ? "none"
        : evidence.failedGateIds.join(", ")
    }`,
    "",
    "Gates:",
    ...evidence.gates.map(formatGate),
    "",
    ...formatNextActions(evidence),
    "",
    "Devices:",
    ...formatDevices(evidence),
  ];

  return `${lines.join("\n")}\n`;
}

function formatGate(gate: PhysicalRoomTrialEvidenceGate) {
  return `${gate.id}  ${gate.passed ? "PASS" : "FAIL"}  observed ${
    gate.observed
  } / required ${gate.required}`;
}

function formatNextActions(evidence: PhysicalRoomTrialEvidence) {
  if (evidence.nextActions.length === 0) {
    return ["Next actions: none"];
  }

  return [
    "Next actions:",
    ...evidence.nextActions.flatMap((action, index) => {
      const lines = [
        `${index + 1}. ${action.title}`,
        `   Detail: ${action.detail}`,
        `   Gates: ${action.gates.join(", ") || "none"}`,
      ];

      if (action.blockers.length > 0) {
        lines.push(`   Blockers: ${action.blockers.join(", ")}`);
      }
      if (action.deviceIds.length > 0) {
        lines.push(`   Devices: ${action.deviceIds.join(", ")}`);
      }

      return lines;
    }),
  ];
}

function formatDevices(evidence: PhysicalRoomTrialEvidence) {
  if (evidence.summary.devices.length === 0) {
    return ["none"];
  }

  return evidence.summary.devices.map((device) => {
    return [
      device.deviceId,
      `role=${device.role}`,
      `localized=${device.finalLocalized ? "yes" : "no"}`,
      `capture=${device.finalCaptureStatus}`,
      `timestamp=${device.finalAudioTimestampReady ? "yes" : "no"}`,
      `distance=${formatDistance(device.finalDistanceMeters)}`,
      `blockers=${formatBlockers(device.finalBlockers)}`,
    ].join("  ");
  });
}

function formatDistance(distanceMeters: number | null) {
  return distanceMeters === null ? "unknown" : `${distanceMeters.toFixed(2)}m`;
}

function formatBlockers(blockers: string[]) {
  return blockers.length === 0 ? "none" : blockers.join(",");
}
