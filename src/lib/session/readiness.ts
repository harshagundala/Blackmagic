import {
  redisRestCredentials,
  type SessionEnvironment,
  type SessionStore,
} from "./store";

export type SessionStoreReadiness = {
  durable: boolean;
  kind: "memory" | "redis";
  status: "ready" | "degraded" | "local";
  missing: string[];
  detail: string;
};

const redisEnvKeys = [
  "BLACKMAGIC_KV_REST_API_URL",
  "BLACKMAGIC_KV_REST_API_TOKEN",
] as const;

export function sessionStoreReadiness({
  env = process.env,
  nodeEnv = process.env.NODE_ENV,
  runtimeKind,
}: {
  env?: SessionEnvironment;
  nodeEnv?: string;
  runtimeKind?: SessionStore["kind"];
} = {}): SessionStoreReadiness {
  const credentials = redisRestCredentials(env);
  const missing = redisEnvKeys.filter((key) => !env[key]);
  if (credentials) {
    if (runtimeKind === "memory") {
      return {
        durable: false,
        kind: "memory",
        status: "degraded",
        missing: [],
        detail:
          "Redis is configured but unavailable; using process-local memory.",
      };
    }

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
