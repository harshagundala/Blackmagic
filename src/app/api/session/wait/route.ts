import { getSessionStore } from "@/lib/session/server-registry";
import { waitForRoomStateRevision } from "@/lib/session/wait";

const MAX_WAIT_MS = 8_000;
const DEFAULT_WAIT_MS = 4_500;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionUrl = url.searchParams.get("url");

  if (!sessionUrl) {
    return Response.json({ error: "missing_url" }, { status: 400 });
  }

  const afterRevision = nonNegativeNumber(url.searchParams.get("revision")) ?? 0;
  const timeoutMs = Math.min(
    MAX_WAIT_MS,
    nonNegativeNumber(url.searchParams.get("timeoutMs")) ?? DEFAULT_WAIT_MS,
  );

  return Response.json(
    await waitForRoomStateRevision(getSessionStore(), sessionUrl, {
      afterRevision,
      timeoutMs,
    }),
  );
}

function nonNegativeNumber(value: string | null) {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
