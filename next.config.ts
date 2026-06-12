import type { NextConfig } from "next";

// One id per build, inlined into BOTH the client and server bundles at build
// time (env config is applied by DefinePlugin to every bundle). The client
// compares its inlined id against /api/build to detect that it is a stale
// tab from a previous deploy: a room with mixed bundle versions chirps with
// mismatched parameters and silently never ranges — a stale tab must reload
// itself instead of poisoning the room.
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  `local-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
};

export default nextConfig;
