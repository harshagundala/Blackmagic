import { getSessionStore } from "@/lib/session/server-registry";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    deviceId?: string;
    url?: string;
  } | null;

  if (!body?.deviceId || !body?.url) {
    return Response.json({ error: "missing_device_or_url" }, { status: 400 });
  }

  const claim = await getSessionStore().claim(body.url, body.deviceId);
  return Response.json(claim);
}
