import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getSessionStore } from "@/lib/session/server-registry";
import { parseSessionUrl } from "@/lib/session/session-url";
import {
  parseRecordingPath,
  sanitizeSegment,
} from "@/lib/recording/paths";

// Token broker for client-side recording uploads. Phones upload their
// full-resolution WAV takes (often tens of MB) directly to Blob storage —
// far past the serverless body limit — so the route never proxies audio
// bytes. It only mints scoped tokens, and only for callers that prove room
// membership: the client payload names a device and the room URL, the
// device must be registered in that room's state, and the requested path
// must be exactly that device's slot under that room's sessionKey. Blobs
// stay `public` by design: the path embeds the room's unguessable
// sessionKey plus a random take id, matching the app's URL-is-the-secret
// model, and ground-truth analysis fetches the files directly.
export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json(
      { error: "blob_storage_not_configured" },
      { status: 503 },
    );
  }

  // Browser-only flow: uploads come from the app's own pages.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host || !originMatchesHost(origin, host)) {
    return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as HandleUploadBody | null;
  if (!body) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const path = parseRecordingPath(pathname);
        if (!path) {
          throw new Error("invalid_recording_path");
        }

        const payload = parseClientPayload(clientPayload);
        if (!payload) {
          throw new Error("missing_device_identity");
        }
        const parsedSessionUrl = parseSessionUrl(payload.url);
        if (!parsedSessionUrl) {
          throw new Error("invalid_session_url");
        }
        const room = await getSessionStore().state(parsedSessionUrl);
        const isMember = room.devices.some(
          (device) => device.deviceId === payload.deviceId,
        );
        if (!isMember) {
          throw new Error("not_a_room_member");
        }
        if (path.sessionSegment !== sanitizeSegment(room.sessionKey)) {
          throw new Error("session_mismatch");
        }
        // A device may only write its own slot; cross-device overwrites are
        // rejected even within the same room.
        if (path.deviceSegment !== sanitizeSegment(payload.deviceId)) {
          throw new Error("device_mismatch");
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

function parseClientPayload(
  clientPayload: string | null | undefined,
): { url: string; deviceId: string } | null {
  if (!clientPayload) {
    return null;
  }
  try {
    const parsed = JSON.parse(clientPayload) as {
      url?: unknown;
      deviceId?: unknown;
    };
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.deviceId !== "string" ||
      parsed.deviceId.length === 0
    ) {
      return null;
    }
    return { url: parsed.url, deviceId: parsed.deviceId };
  } catch {
    return null;
  }
}

function originMatchesHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
