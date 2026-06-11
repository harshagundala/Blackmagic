// Blob path discipline for recording uploads, shared by the uploading client
// and the token-minting route so both sides agree on exactly one shape:
//
//   blackmagic/recordings/<sessionKey>/<recordingId>/<deviceId>.(wav|json)
//
// Segments are reduced to [A-Za-z0-9_-] (no dots, so no traversal or hidden
// extension tricks) and the route validates the FULL path against the strict
// pattern — never a prefix check.

export const RECORDING_PATH_PATTERN =
  /^blackmagic\/recordings\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\.(wav|json)$/;

export function sanitizeSegment(value: string) {
  const cleaned = value
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "unknown";
}

export function recordingBasePath(
  sessionKey: string,
  recordingId: string,
  deviceId: string,
) {
  return `blackmagic/recordings/${sanitizeSegment(sessionKey)}/${sanitizeSegment(
    recordingId,
  )}/${sanitizeSegment(deviceId)}`;
}

// Splits a validated upload pathname into its identifying segments.
export function parseRecordingPath(pathname: string) {
  if (!RECORDING_PATH_PATTERN.test(pathname)) {
    return null;
  }
  const segments = pathname.split("/");
  return {
    sessionSegment: segments[2],
    recordingSegment: segments[3],
    deviceSegment: segments[4].replace(/\.(wav|json)$/, ""),
  };
}
