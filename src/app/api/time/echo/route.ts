import { randomUUID } from "node:crypto";

// Stable for the lifetime of this server process. Serverless platforms run
// many instances whose Date.now() baselines can differ; clients group clock
// exchanges by instance so offsets from different processes are never mixed.
const serverInstanceId = randomUUID();

export async function POST() {
  const receivePerfMs = performance.now();
  const serverReceiveEpochMs = Date.now();
  const serverSendEpochMs =
    serverReceiveEpochMs + (performance.now() - receivePerfMs);

  return Response.json({
    serverReceiveEpochMs,
    serverSendEpochMs,
    serverInstanceId,
  });
}
