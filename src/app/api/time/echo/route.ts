export async function POST() {
  const serverReceiveEpochMs = Date.now();
  const serverSendEpochMs = Date.now();

  return Response.json({
    serverReceiveEpochMs,
    serverSendEpochMs,
  });
}
