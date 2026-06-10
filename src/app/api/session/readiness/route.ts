import { sessionStoreReadiness } from "@/lib/session/readiness";
import { getSessionStore } from "@/lib/session/server-registry";

export async function GET() {
  const configuredReadiness = sessionStoreReadiness();
  const store = getSessionStore();

  if (configuredReadiness.kind === "redis") {
    await store.state("https://blackmagic.local/__readiness").catch(() => null);
  }

  return Response.json(sessionStoreReadiness({ runtimeKind: store.kind }));
}
