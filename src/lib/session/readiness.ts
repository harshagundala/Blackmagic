import { redisRestCredentials, type SessionEnvironment } from "./store";

export type SessionStoreReadiness = {
  durable: boolean;
  kind: "memory" | "redis";
  status: "ready" | "degraded" | "local";
  missing: string[];
  detail: string;
};

const redisEnvKeys = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;

export function sessionStoreReadiness({
  env = process.env,
  nodeEnv = process.env.NODE_ENV,
}: {
  env?: SessionEnvironment;
  nodeEnv?: string;
} = {}): SessionStoreReadiness {
  const credentials = redisRestCredentials(env);
  const missing = redisEnvKeys.filter((key) => !env[key]);
  if (credentials) {
    return {
      durable: true,
      kind: "redis",
      status: "ready",
      missing: [],
      detail: "Production room state is backed by Redis.",
    };
  }

  const isProduction = nodeEnv === "production";
  return {
    durable: false,
    kind: "memory",
    status: isProduction ? "degraded" : "local",
    missing,
    detail: isProduction
      ? "Production room state is process-local until Redis env is configured."
      : "Local development is using the in-memory session store.",
  };
}
