import { describe, expect, test } from "vitest";
import { sessionStoreReadiness } from "./readiness";

describe("session store readiness", () => {
  test("reports degraded production readiness without durable Redis env", () => {
    expect(
      sessionStoreReadiness({
        env: {},
        nodeEnv: "production",
      }),
    ).toEqual({
      durable: false,
      kind: "memory",
      status: "degraded",
      missing: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
      detail: "Production room state is process-local until Redis env is configured.",
    });
  });

  test("reports durable readiness when Upstash Redis env is configured", () => {
    expect(
      sessionStoreReadiness({
        env: {
          UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
          UPSTASH_REDIS_REST_TOKEN: "secret",
        },
        nodeEnv: "production",
      }),
    ).toEqual({
      durable: true,
      kind: "redis",
      status: "ready",
      missing: [],
      detail: "Production room state is backed by Redis.",
    });
  });

  test("reports durable readiness for Vercel Marketplace Redis env", () => {
    expect(
      sessionStoreReadiness({
        env: {
          KV_REST_API_URL: "https://example.upstash.io",
          KV_REST_API_TOKEN: "secret",
        },
        nodeEnv: "production",
      }),
    ).toEqual({
      durable: true,
      kind: "redis",
      status: "ready",
      missing: [],
      detail: "Production room state is backed by Redis.",
    });
  });

  test("keeps local memory fallback explicit in development", () => {
    expect(
      sessionStoreReadiness({
        env: {},
        nodeEnv: "development",
      }),
    ).toEqual(
      expect.objectContaining({
        durable: false,
        kind: "memory",
        status: "local",
      }),
    );
  });
});
