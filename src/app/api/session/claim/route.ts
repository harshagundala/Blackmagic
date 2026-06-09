import { getSessionStore } from "@/lib/session/server-registry";
import {
  invalidSessionUrlResponse,
  parseSessionUrl,
} from "../../../../lib/session/session-url";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    deviceId?: string;
    url?: string;
  } | null;

  if (!body?.deviceId || !body?.url) {
    return Response.json({ error: "missing_device_or_url" }, { status: 400 });
  }

  const sessionUrl = parseSessionUrl(body.url);
  if (!sessionUrl) {
    return invalidSessionUrlResponse();
  }

  const claim = await getSessionStore().claim(sessionUrl, body.deviceId);
  return Response.json(claim);
}
