import { getSessionStore } from "@/lib/session/server-registry";
import {
  invalidSessionUrlResponse,
  parseSessionUrl,
} from "../../../../lib/session/session-url";
import type {
  RealtimeSignalInput,
  RealtimeSignalPayload,
} from "@/lib/realtime/contracts";

const MAX_SDP_CHARS = 64_000;
const MAX_CANDIDATE_CHARS = 8_000;
const MAX_DEVICE_ID_CHARS = 128;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    url?: string;
    signal?: unknown;
  } | null;

  if (!body?.url || !body.signal) {
    return Response.json({ error: "missing_signal_or_url" }, { status: 400 });
  }

  const sessionUrl = parseSessionUrl(body.url);
  if (!sessionUrl) {
    return invalidSessionUrlResponse();
  }

  const signal = normalizeRealtimeSignalInput(body.signal);
  if (!signal) {
    return Response.json({ error: "invalid_signal" }, { status: 400 });
  }

  return Response.json(
    await getSessionStore().publishRealtimeSignal(sessionUrl, signal),
  );
}

function normalizeRealtimeSignalInput(
  value: unknown,
): RealtimeSignalInput | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    !validDeviceId(value.fromDeviceId) ||
    !validDeviceId(value.toDeviceId) ||
    value.fromDeviceId === value.toDeviceId
  ) {
    return null;
  }

  if (
    value.kind !== "offer" &&
    value.kind !== "answer" &&
    value.kind !== "ice-candidate"
  ) {
    return null;
  }

  const payload = normalizeSignalPayload(value.kind, value.payload);
  if (!payload) {
    return null;
  }

  return {
    fromDeviceId: value.fromDeviceId,
    toDeviceId: value.toDeviceId,
    kind: value.kind,
    payload,
  };
}

function normalizeSignalPayload(
  kind: RealtimeSignalInput["kind"],
  payload: unknown,
): RealtimeSignalPayload | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (kind === "offer" || kind === "answer") {
    const payloadType =
      payload.type === "offer" || payload.type === "answer"
        ? payload.type
        : null;
    if (
      payloadType !== kind ||
      typeof payload.sdp !== "string" ||
      payload.sdp.length === 0 ||
      payload.sdp.length > MAX_SDP_CHARS
    ) {
      return null;
    }

    return {
      type: payloadType,
      sdp: payload.sdp,
    };
  }

  if (
    typeof payload.candidate !== "string" ||
    payload.candidate.length === 0 ||
    payload.candidate.length > MAX_CANDIDATE_CHARS
  ) {
    return null;
  }

  return {
    candidate: payload.candidate,
    sdpMid:
      typeof payload.sdpMid === "string" || payload.sdpMid === null
        ? payload.sdpMid
        : undefined,
    sdpMLineIndex:
      typeof payload.sdpMLineIndex === "number" &&
      Number.isFinite(payload.sdpMLineIndex)
        ? payload.sdpMLineIndex
        : payload.sdpMLineIndex === null
          ? null
          : undefined,
    usernameFragment:
      typeof payload.usernameFragment === "string" ||
      payload.usernameFragment === null
        ? payload.usernameFragment
        : undefined,
  };
}

function validDeviceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_DEVICE_ID_CHARS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
