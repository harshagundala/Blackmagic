import { compactRoomStateForTransport } from "@/lib/session/registry";
import { getSessionStore } from "@/lib/session/server-registry";
import {
  invalidSessionUrlResponse,
  parseSessionUrl,
} from "../../../../lib/session/session-url";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionUrl = url.searchParams.get("url");

  if (!sessionUrl) {
    return Response.json({ error: "missing_url" }, { status: 400 });
  }

  const parsedSessionUrl = parseSessionUrl(sessionUrl);
  if (!parsedSessionUrl) {
    return invalidSessionUrlResponse();
  }

  return Response.json(
    compactRoomStateForTransport(
      await getSessionStore().state(parsedSessionUrl),
    ),
  );
}
