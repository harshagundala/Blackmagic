import { getSessionStore } from "@/lib/session/server-registry";
import {
  compactRoomStateForTransport,
  type DeviceHeartbeat,
} from "@/lib/session/registry";
import {
  invalidSessionUrlResponse,
  parseSessionUrl,
} from "../../../../lib/session/session-url";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    deviceId?: string;
    url?: string;
    heartbeat?: DeviceHeartbeat;
    responseMode?: "ack" | "state";
  } | null;

  if (!body?.deviceId || !body?.url) {
    return Response.json({ error: "missing_device_or_url" }, { status: 400 });
  }

  const sessionUrl = parseSessionUrl(body.url);
  if (!sessionUrl) {
    return invalidSessionUrlResponse();
  }

  const store = getSessionStore();
  if (body.responseMode === "ack" && store.heartbeatReceipt) {
    return Response.json(
      await store.heartbeatReceipt(sessionUrl, body.deviceId, body.heartbeat),
    );
  }

  const state = await store.heartbeat(
    sessionUrl,
    body.deviceId,
    body.heartbeat,
  );
  return Response.json(compactRoomStateForTransport(state));
}
