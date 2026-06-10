import { getSessionStore } from "@/lib/session/server-registry";
import {
  invalidSessionUrlResponse,
  parseSessionUrl,
} from "../../../../lib/session/session-url";

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const deviceId = searchParams.get("deviceId");
  const sessionUrl = parseSessionUrl(searchParams.get("url"));

  if (!deviceId || !searchParams.get("url")) {
    return Response.json({ error: "missing_device_or_url" }, { status: 400 });
  }

  if (!sessionUrl) {
    return invalidSessionUrlResponse();
  }

  return Response.json({
    signals: await getSessionStore().realtimeSignals(
      sessionUrl,
      deviceId,
      parseSequence(searchParams.get("since")),
    ),
  });
}

function parseSequence(value: string | null) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
