export function parseSessionUrl(value: string | null | undefined) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function invalidSessionUrlResponse() {
  return Response.json({ error: "invalid_url" }, { status: 400 });
}
