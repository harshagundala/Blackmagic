import type { RealtimeConfig } from "@/lib/realtime/contracts";

export async function GET() {
  const config: RealtimeConfig = {
    mode: process.env.ABLY_API_KEY ? "provider" : "demo",
    provider: process.env.ABLY_API_KEY ? "ably" : "none",
    roomTtlSeconds: 60 * 30,
  };

  return Response.json(config);
}
