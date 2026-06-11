// Client-side upload of a recorded take: the full-resolution WAV plus a JSON
// sidecar with everything offline analysis needs to reconcile the streams
// against ground truth — sample anchors, discontinuities, the device's clock
// model, and capture diagnostics.

import { upload } from "@vercel/blob/client";
import { encodeWavPcm16 } from "./wav";
import { recordingBasePath } from "./paths";
import type { RecordedTake } from "./capture-recorder";

export type RecordingUploadContext = {
  deviceId: string;
  sessionKey: string;
  // The room URL this device joined with; the token route verifies the
  // device is a member of that room before minting an upload token.
  sessionUrl: string;
  role: "host" | "phone";
  sampleRateReported: number | null;
  captureMode: string | null;
  clock: {
    offsetMs: number | null;
    uncertaintyMs: number | null;
    maxErrorMs: number | null;
    samplesUsed: number | null;
  } | null;
};

export type RecordingUploadResult = {
  wavUrl: string;
  metaUrl: string;
};

export async function uploadRecordedTake(
  take: RecordedTake,
  context: RecordingUploadContext,
): Promise<RecordingUploadResult> {
  const base = recordingBasePath(
    context.sessionKey,
    take.recordingId,
    context.deviceId,
  );
  const clientPayload = JSON.stringify({
    url: context.sessionUrl,
    deviceId: context.deviceId,
  });

  const wavBlob = new Blob([encodeWavPcm16(take.samples, take.sampleRate)], {
    type: "audio/wav",
  });
  const wavResult = await upload(`${base}.wav`, wavBlob, {
    access: "public",
    handleUploadUrl: "/api/recordings/upload",
    contentType: "audio/wav",
    clientPayload,
  });

  const metadata = {
    recordingId: take.recordingId,
    deviceId: context.deviceId,
    role: context.role,
    sessionKey: context.sessionKey,
    sampleRate: take.sampleRate,
    sampleRateReported: context.sampleRateReported,
    firstSampleIndex: take.firstSampleIndex,
    lastSampleIndex: take.lastSampleIndex,
    sampleCount: take.samples.length,
    discontinuities: take.discontinuities,
    truncated: take.truncated,
    startedAtEpochMs: take.startedAtEpochMs,
    endedAtEpochMs: take.endedAtEpochMs,
    captureMode: context.captureMode,
    clock: context.clock,
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : null,
    format: "pcm16-mono-wav",
  };
  const metaResult = await upload(
    `${base}.json`,
    new Blob([JSON.stringify(metadata, null, 2)], {
      type: "application/json",
    }),
    {
      access: "public",
      handleUploadUrl: "/api/recordings/upload",
      contentType: "application/json",
      clientPayload,
    },
  );

  return { wavUrl: wavResult.url, metaUrl: metaResult.url };
}
