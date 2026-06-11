import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

// Token broker for client-side recording uploads. Phones upload their
// full-resolution WAV takes (often tens of MB) directly to Blob storage —
// far past the serverless body limit — so the route only authorizes paths
// and types, it never proxies audio bytes.
export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json(
      { error: "blob_storage_not_configured" },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as HandleUploadBody | null;
  if (!body) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("blackmagic/recordings/")) {
          throw new Error("invalid_recording_path");
        }
        return {
          allowedContentTypes: ["audio/wav", "application/json"],
          addRandomSuffix: false,
          maximumSizeInBytes: 64 * 1024 * 1024,
        };
      },
      // Upload confirmations are read live over the data channel; nothing to
      // persist here.
      onUploadCompleted: async () => {},
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "upload_failed" },
      { status: 400 },
    );
  }
}
