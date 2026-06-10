import { describe, expect, test } from "vitest";
import {
  audioFrameTimestamp,
  audioSampleTimestamp,
  estimateClockOffset,
  identityClockModel,
  projectClockModel,
  retainClockExchanges,
  robustClockModel,
  selectClockModel,
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
    expect(model.bestRoundTripMs).toBe(28);
    expect(model.jitterMs).toBeCloseTo(0.816, 3);
    // Conservative bound: best half-round-trip plus twice the offset scatter.
    expect(model.maxErrorMs).toBeCloseTo(15.633, 3);
    expect(model.uncertaintyMs).toBeLessThan(model.maxErrorMs);
    expect(model.quality).toBeGreaterThan(0.8);
    expect(model.samplesUsed).toBe(3);
    expect(model.driftMsPerSecond).toBe(0);
  });

  test("models only the dominant server instance when exchanges mix instances", () => {
    const sameInstance = [
      makeExchange(100, 30, { instanceId: "a", receiveAtPerfMs: 1_100 }),
      makeExchange(101, 28, { instanceId: "a", receiveAtPerfMs: 1_400 }),
      makeExchange(100, 32, { instanceId: "a", receiveAtPerfMs: 1_700 }),
    ];
    const skewedInstance = [
      makeExchange(146, 26, { instanceId: "b", receiveAtPerfMs: 1_550 }),
    ];

    const model = robustClockModel([...sameInstance, ...skewedInstance]);

    expect(model.offsetMs).toBeCloseTo(100, 0);
    expect(model.crossInstanceRejected).toBe(1);
  });

  test("fits clock drift over a long exchange history and projects it forward", () => {
    // 0.1 ms/s drift: offset grows by 1 ms every 10 seconds.
    const exchanges = Array.from({ length: 10 }, (_, index) =>
      makeExchange(100 + index * 0.1, 24, {
        receiveAtPerfMs: 1_000 + index * 1_000,
      }),
    );

    const model = robustClockModel(exchanges);

    expect(model.driftMsPerSecond).toBeCloseTo(0.0001 * 1_000, 2);
    expect(model.sampleSpanMs).toBeGreaterThanOrEqual(6_000);

    const projected = projectClockModel(model, model.referencePerfMs! + 10_000);
    expect(projected.ageMs).toBe(10_000);
    expect(projected.offsetMs).toBeCloseTo(model.offsetMs + 1, 0);
    expect(projected.uncertaintyMs).toBeGreaterThan(model.uncertaintyMs);
  });

  test("widens projected uncertainty for a stale model with no drift estimate", () => {
    const model = robustClockModel([
      makeExchange(100, 30, { receiveAtPerfMs: 2_000 }),
      makeExchange(101, 28, { receiveAtPerfMs: 2_400 }),
    ]);

    const fresh = projectClockModel(model, model.referencePerfMs!);
    const stale = projectClockModel(model, model.referencePerfMs! + 60_000);

    expect(fresh.uncertaintyMs).toBeCloseTo(model.uncertaintyMs, 3);
    expect(stale.uncertaintyMs).toBeGreaterThan(model.uncertaintyMs + 3);
    expect(stale.maxErrorMs).toBeGreaterThan(model.maxErrorMs + 3);
  });

  test("rejects offset outliers even when they have attractive round trips", () => {
    const exchanges: ClockExchange[] = [
      makeExchange(100, 52),
      makeExchange(101, 48),
      makeExchange(99, 50),
      makeExchange(178, 18),
      makeExchange(181, 20),
    ];

    const model = robustClockModel(exchanges);

    expect(model.offsetMs).toBeCloseTo(100, 1);
    expect(model.samplesUsed).toBe(3);
    expect(model.outliersRejected).toBe(2);
    expect(model.offsetStabilityMs).toBeLessThan(1);
    expect(model.quality).toBeGreaterThan(0.7);
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
      clockQuality: 0.91,
      clockMaxErrorMs: 8,
      clockBestRoundTripMs: 16,
      clockJitterMs: 0.7,
      clockSamplesUsed: 7,
      clockOutliersRejected: 2,
      clockOffsetStabilityMs: 0.6,
    });

    expect(stamp.audioElapsedMs).toBeCloseTo(10_010, 3);
    expect(stamp.hostEstimatedEpochMs).toBeCloseTo(1_700_000_002_101.4, 3);
    expect(stamp.clockUncertaintyMs).toBe(8);
    expect(stamp.clockQuality).toBe(0.91);
    expect(stamp.clockSamplesUsed).toBe(7);
    expect(stamp.clockOutliersRejected).toBe(2);
  });

  test("maps historical audio samples through an audio/performance anchor", () => {
    const stamp = audioSampleTimestamp({
      anchorAudioContextTimeSeconds: 10.01,
      anchorPerformanceNowMs: 2_000,
      sampleIndex: 480_240,
      sampleRate: 48_000,
      clientPerfOriginEpochMs: 1_700_000_000_000,
      clockOffsetMs: 101.4,
      clockUncertaintyMs: 8,
      clockQuality: 0.91,
      clockMaxErrorMs: 8,
      clockBestRoundTripMs: 16,
      clockJitterMs: 0.7,
      clockSamplesUsed: 7,
      clockOutliersRejected: 2,
      clockOffsetStabilityMs: 0.6,
    });

    expect(stamp.audioContextTimeSeconds).toBeCloseTo(10.005, 6);
    expect(stamp.performanceNowMs).toBeCloseTo(1_995, 3);
    expect(stamp.audioElapsedMs).toBeCloseTo(10_005, 3);
    expect(stamp.hostEstimatedEpochMs).toBeCloseTo(1_700_000_002_096.4, 3);
    expect(stamp.clockQuality).toBe(0.91);
    expect(stamp.clockMaxErrorMs).toBe(8);
    expect(stamp.clockBestRoundTripMs).toBe(16);
    expect(stamp.clockJitterMs).toBe(0.7);
    expect(stamp.clockSamplesUsed).toBe(7);
    expect(stamp.clockOutliersRejected).toBe(2);
    expect(stamp.clockOffsetStabilityMs).toBe(0.6);
    expect(stamp.timingConfidence).toBeGreaterThan(0.55);
  });

  test("scores timestamp confidence from clock uncertainty and stability", () => {
    const precise = audioFrameTimestamp({
      audioContextTimeSeconds: 4,
      sampleIndex: 192_000,
      sampleRate: 48_000,
      clientPerfOriginEpochMs: 1_700_000_000_000,
      performanceNowMs: 3_000,
      clockOffsetMs: 2,
      clockUncertaintyMs: 2,
      clockQuality: 0.98,
      clockBestRoundTripMs: 4,
      clockJitterMs: 0.2,
      clockSamplesUsed: 10,
      clockOffsetStabilityMs: 0.2,
    });
    const fuzzy = audioFrameTimestamp({
      ...precise,
      clockUncertaintyMs: 42,
      clockQuality: 0.42,
      clockBestRoundTripMs: 160,
      clockJitterMs: 12,
      clockSamplesUsed: 1,
      clockOffsetStabilityMs: 14,
    });

    expect(precise.timingConfidence).toBeGreaterThan(0.7);
    expect(fuzzy.timingConfidence).toBeLessThan(0.12);
  });

  test("keeps a bounded low-latency exchange history for realtime sync", () => {
    const retained = retainClockExchanges(
      [makeExchange(100, 22), makeExchange(101, 24), makeExchange(99, 26)],
      makeExchange(130, 400),
      { maxRoundTripMs: 80, maxSamples: 3 },
    );

    expect(retained.map((exchange) => estimateClockOffset(exchange).offsetMs)).toEqual([
      100,
      101,
      99,
    ]);

    const next = retainClockExchanges(retained, makeExchange(102, 20), {
      maxRoundTripMs: 80,
      maxSamples: 3,
    });

    expect(next.map((exchange) => estimateClockOffset(exchange).offsetMs)).toEqual([
      101,
      99,
      102,
    ]);
  });
});

describe("clock model selection", () => {
  test("the host clock is the identity model with near-zero error", () => {
    const model = selectClockModel({
      authority: "self",
      peerExchanges: [makeExchange(120, 8)],
      serverExchanges: [makeExchange(90, 60)],
      nowPerfMs: 1_500,
    });

    expect(model.offsetMs).toBe(0);
    expect(model.maxErrorMs).toBeLessThan(1);
    expect(model.quality).toBe(1);
    expect(model.samplesUsed).toBeGreaterThanOrEqual(4);
  });

  test("peer exchanges against the host outrank the HTTP server path", () => {
    const peerExchanges = [
      makeExchange(250, 8),
      makeExchange(251, 10),
      makeExchange(250, 12),
    ];
    const serverExchanges = [makeExchange(90, 80), makeExchange(92, 90)];

    const model = selectClockModel({
      authority: "external",
      peerExchanges,
      serverExchanges,
      nowPerfMs: 12_000,
    });

    expect(model.offsetMs).toBeCloseTo(250, 0);
    expect(model.bestRoundTripMs).toBe(8);
  });

  test("holds the peer domain even when probes go quiet — never jumps back to the server domain", () => {
    const model = selectClockModel({
      authority: "external",
      peerExchanges: [makeExchange(250, 8)],
      serverExchanges: [makeExchange(90, 80), makeExchange(92, 90)],
      nowPerfMs: 60_000,
    });

    expect(model.offsetMs).toBeCloseTo(250, 0);
  });

  test("uses the server prior before any peer probe has landed", () => {
    const model = selectClockModel({
      authority: "external",
      peerExchanges: [],
      serverExchanges: [makeExchange(90, 80), makeExchange(92, 90)],
      nowPerfMs: 5_000,
    });

    expect(model.offsetMs).toBeCloseTo(91, 0);
  });

  test("identity model keeps projecting with tight bounds", () => {
    const model = identityClockModel(2_000);
    const projected = projectClockModel(model, 4_000);

    expect(projected.offsetMs).toBe(0);
    expect(projected.maxErrorMs).toBeLessThan(1);
  });
});

function makeExchange(
  offsetMs: number,
  roundTripMs: number,
  options: { instanceId?: string; receiveAtPerfMs?: number } = {},
): ClockExchange {
  const clientPerfOriginEpochMs = 10_000;
  const serverProcessingMs = 4;
  const oneWayMs = roundTripMs / 2;
  const clientReceivePerfMs =
    options.receiveAtPerfMs ?? 1_000 + roundTripMs + serverProcessingMs;
  const clientSendPerfMs =
    clientReceivePerfMs - roundTripMs - serverProcessingMs;
  const clientSendEpochMs = clientPerfOriginEpochMs + clientSendPerfMs;

  return {
    clientPerfOriginEpochMs,
    clientSendPerfMs,
    serverReceiveEpochMs: clientSendEpochMs + offsetMs + oneWayMs,
    serverSendEpochMs: clientSendEpochMs + offsetMs + oneWayMs + serverProcessingMs,
    clientReceivePerfMs,
    serverInstanceId: options.instanceId ?? null,
  };
}
