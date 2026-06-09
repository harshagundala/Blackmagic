import { describe, expect, test } from "vitest";
import {
  audioFrameTimestamp,
  estimateClockOffset,
  robustClockModel,
  type ClockExchange,
} from "./clock-sync";

describe("clock sync metadata", () => {
  test("estimates client-to-host offset with NTP-style midpoint timing", () => {
    const exchange: ClockExchange = {
      clientPerfOriginEpochMs: 1_000,
      clientSendPerfMs: 500,
      serverReceiveEpochMs: 1_620,
      serverSendEpochMs: 1_624,
      clientReceivePerfMs: 548,
    };

    const estimate = estimateClockOffset(exchange);

    expect(estimate.offsetMs).toBeCloseTo(98, 3);
    expect(estimate.roundTripMs).toBe(44);
    expect(estimate.uncertaintyMs).toBe(22);
  });

  test("builds a robust clock model from low-latency exchanges", () => {
    const exchanges: ClockExchange[] = [
      makeExchange(100, 34),
      makeExchange(102, 30),
      makeExchange(101, 28),
      makeExchange(144, 210),
    ];

    const model = robustClockModel(exchanges);

    expect(model.offsetMs).toBeCloseTo(101, 1);
    expect(model.uncertaintyMs).toBeLessThan(20);
    expect(model.quality).toBeGreaterThan(0.8);
    expect(model.samplesUsed).toBe(3);
  });

  test("timestamps audio by sample index and preserves host-aligned estimate", () => {
    const stamp = audioFrameTimestamp({
      audioContextTimeSeconds: 10,
      sampleIndex: 480_480,
      sampleRate: 48_000,
      clientPerfOriginEpochMs: 1_700_000_000_000,
      performanceNowMs: 2_000,
      clockOffsetMs: 101.4,
      clockUncertaintyMs: 8,
    });

    expect(stamp.audioElapsedMs).toBeCloseTo(10_010, 3);
    expect(stamp.hostEstimatedEpochMs).toBeCloseTo(1_700_000_002_101.4, 3);
    expect(stamp.clockUncertaintyMs).toBe(8);
  });
});

function makeExchange(offsetMs: number, roundTripMs: number): ClockExchange {
  const clientPerfOriginEpochMs = 10_000;
  const clientSendPerfMs = 1_000;
  const serverProcessingMs = 4;
  const oneWayMs = roundTripMs / 2;
  const clientSendEpochMs = clientPerfOriginEpochMs + clientSendPerfMs;

  return {
    clientPerfOriginEpochMs,
    clientSendPerfMs,
    serverReceiveEpochMs: clientSendEpochMs + offsetMs + oneWayMs,
    serverSendEpochMs: clientSendEpochMs + offsetMs + oneWayMs + serverProcessingMs,
    clientReceivePerfMs: clientSendPerfMs + roundTripMs + serverProcessingMs,
  };
}
