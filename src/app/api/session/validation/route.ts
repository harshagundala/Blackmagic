import { estimateRoomConstellation } from "../../../../lib/positioning/room-state-layout";
import { validatePhysicalRoomLocalization } from "../../../../lib/research/physical-room-validation";
import { getSessionStore } from "../../../../lib/session/server-registry";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionUrl = url.searchParams.get("url");

  if (!sessionUrl) {
    return Response.json({ error: "missing_url" }, { status: 400 });
  }

  const roomState = await getSessionStore().state(sessionUrl);
  const constellation = estimateRoomConstellation(roomState);

  return Response.json({
    sessionKey: roomState.sessionKey,
    revision: roomState.revision,
    updatedAt: roomState.updatedAt,
    validation: validatePhysicalRoomLocalization(roomState, constellation),
  });
}
