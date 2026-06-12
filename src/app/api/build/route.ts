// The deployment's build id, for stale-tab detection. NEXT_PUBLIC_BUILD_ID
// is inlined at build time into this server bundle, so the value always
// matches the client bundle produced by the same build.
export async function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? "unknown" },
    { headers: { "cache-control": "no-store" } },
  );
}
