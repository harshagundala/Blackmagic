import { sessionStoreReadiness } from "@/lib/session/readiness";

export async function GET() {
  return Response.json(sessionStoreReadiness());
}
