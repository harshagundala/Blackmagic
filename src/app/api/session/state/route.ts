import { compactRoomStateForTransport } from "@/lib/session/registry";
import { getSessionStore } from "@/lib/session/server-registry";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionUrl = url.searchParams.get("url");

  if (!sessionUrl) {
    return Response.json({ error: "missing_url" }, { status: 400 });
  }

  return Response.json(
    compactRoomStateForTransport(await getSessionStore().state(sessionUrl)),
  );
}
