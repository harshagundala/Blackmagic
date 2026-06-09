import { estimateRoomConstellation } from "../../../../lib/positioning/room-state-layout";
import { validatePhysicalRoomLocalization } from "../../../../lib/research/physical-room-validation";
import { getSessionStore } from "../../../../lib/session/server-registry";
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

  const roomState = await getSessionStore().state(parsedSessionUrl);
  const constellation = estimateRoomConstellation(roomState);

  return Response.json({
    sessionKey: roomState.sessionKey,
    revision: roomState.revision,
    updatedAt: roomState.updatedAt,
    validation: validatePhysicalRoomLocalization(roomState, constellation),
  });
}
