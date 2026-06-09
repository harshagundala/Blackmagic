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
  } | null;

  if (!body?.deviceId || !body?.url) {
    return Response.json({ error: "missing_device_or_url" }, { status: 400 });
  }

  const sessionUrl = parseSessionUrl(body.url);
  if (!sessionUrl) {
    return invalidSessionUrlResponse();
  }

  const state = await getSessionStore().heartbeat(
    sessionUrl,
    body.deviceId,
    body.heartbeat,
  );
  return Response.json(compactRoomStateForTransport(state));
}
