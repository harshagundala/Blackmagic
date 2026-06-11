# Host-Node Passive Acoustic Reconciliation (UI v2)

Date: 2026-06-10
Status: approved for implementation (autonomous session; user requested the
feature end-to-end and asked for deep research up front)

## Goal

In Blackmagic UI v2 (the waveform app), the host phone derives **inter-device
distance and relative 2D position** purely from ambient speech that every
phone hears — no chirps required. Works with 2 devices (distance), improves
with 3+ (triangulated 2D constellation plus a live "talker" position). Active
inaudible chirps remain a separate, later goal; the design leaves a fusion
hook for them.

## Physics and method (from literature)

> **Amendment (2026-06-10, after first field test):** TDOA is measured in the
> **sample domain**, not the host clock domain. Field testing showed host
> clock mappings on real iPhones wobble several ms between events (clock
> model re-estimation + pipeline latency shifts), which the spread estimator
> reads as phantom distance (a 2 ft pair measured 6+ m). Each device's ADC
> sample counter is gapless, so `centerSampleIndex / sourceSampleRate` is an
> exact device-local timestamp; differencing those across devices plus the
> GCC offset leaves a Δ that is the capture-start gap — large but constant to
> within the sample-rate offset, with zero per-event clock jitter. Host-epoch
> stamps are used only for clustering and windowing. Capture restarts jump
> the origin; a consistent-regime detector re-seeds the pair history when
> that happens.

Per voice event, per device pair (A, B), the measured arrival-time difference
is:

```
τ = (d_B − d_A)/c + Δ_AB(t)
```

where `d_X` is talker→device distance and `Δ_AB(t)` is a per-pair nuisance
term (see amendment: the capture-start gap plus fixed input latency
difference), drifting slowly with the ADC sample-rate offset (~20 ppm ≈
0.7 cm/s of apparent drift).

A single τ only constrains a hyperbola. But as the talker moves,
`(d_B − d_A)/c` sweeps the interval `[−d_AB/c, +d_AB/c]`, while `Δ_AB`
stays (affinely) constant. So per pair (extreme-TDOA method, Hon/Wang
TASLP 2015 + SRO correction):

1. Collect gated TDOA observations `(τ_k, t_k, w_k)` over a sliding window.
2. Robust drift fit (Theil–Sen) of τ vs t; de-drift: `τ'_k = τ_k − ε̂·t_k`.
3. Density-filter the τ' histogram (drop isolated outlier bins).
4. Weighted robust extremes: `τ_lo = P5, τ_hi = P95`.
5. `d̂ = c·(τ_hi − τ_lo)/2`, `Δ̂ = (τ_hi + τ_lo)/2`.

`d̂` converges to the true distance **from below** (it is exact once the
talker crosses both endfire directions; 25° off endfire is only a 9%
underestimate). We therefore expose a `coverage` metric and report the
estimate honestly as "at least X m" until coverage is good. Expected
steady-state accuracy: 5–20 cm with a moving talker (literature-backed);
the clock sync accuracy does NOT bound the distance accuracy because Δ̂ is
estimated jointly.

With 3+ devices, pairwise distances feed the existing stress-minimization
layout solver (`estimateConstellation`), and per-event TDOA vectors locate
the talker (grid + refinement, the same approach v1's `tdoa-grid` hints use)
— the bias-corrected TDOAs make this work on the host with fresh data.

## What already exists (reused, not rebuilt)

- `captureAudioSnippet` / `estimateRawAudioOffset` (GCC-PHAT with parabolic
  sub-sample refinement, PHAT peak + peak-ratio quality) — the measurement
  core. Voice events already carry 240 ms / 8 kHz snippets; the useful TDOA
  band for speech is ~300 Hz–4 kHz, so 8 kHz decimation is appropriate.
- `detectVoiceActivityEvent` + `attachSpeechFingerprint` in
  `use-sensor-suite` — every device already produces `VoiceActivityEvent`s
  with snippets locally.
- `deriveReconciledAudioEvents` — clusters voice events across devices and
  computes pairwise-usable GCC alignments. Runs anywhere; we run it on the
  host.
- Clock sync over data channels (host epoch domain), motion stability,
  heading, `estimateConstellation` layout solver, WebRTC star topology with
  host relay.

## What's new

### 1. Voice events travel over the data channel (`src/lib/realtime/`)

New message `RealtimeVoiceEventMessage`:

```ts
{ type: "voice-event"; version: 1; fromDeviceId: string; event: VoiceActivityEvent }
```

- Sent by every device when a new voice event fires (deduped by event id,
  same pattern as chirp/pulse messages in `use-webrtc-room`).
- Validated in `data-channel.ts` (`isPlausibleAudioSnippet`, size caps).
- Host relays it star-wise like sensor frames (symmetry, future edge use).
- Snippet ≈ 2.6 KB base64; events are min-spaced 650 ms per device — trivial
  bandwidth for a data channel.

### 2. Reconciliation library (`src/lib/reconciliation/`) — pure, testable

- `tdoa-observations.ts` — `derivePairTdoaObservations(event)`: for each
  device pair in a reconciled event with snippets, run GCC-PHAT directly
  between the pair, gate on correlation / PHAT peak / peak ratio, and emit
  `{ pairKey, from, to, tdoaMs, weight, atHostEpochMs, eventId }` with
  `tdoaMs = (t_B − t_A) + gccOffsetMs`. For events seen by 3+ devices,
  triangle-closure residual (`τ_AB + τ_BC − τ_AC`) gates inconsistent
  matches.
- `pair-tdoa-history.ts` — per-pair sliding-window accumulator
  (`recordTdoaObservation`, `prunePairHistory`, `clearDevicePairs`):
  bounded buffer (~150 obs / ~150 s), median outlier gate (|τ−median| ≤
  ~30 ms), Theil–Sen drift removal, weighted percentile extremes, and
  derived `PairRangeEstimate`:

  ```ts
  { from, to, meters, uncertaintyMeters, biasMs, driftMsPerSecond,
    coverage,      // 0..1: convergence quality (see below)
    samplesUsed, confidence, observedAtHostEpochMs }
  ```

  `coverage` measures convergence quality of the extremes (evidence density
  at both ends of the span, span stability over the window, sample count) —
  NOT endfire coverage. A broadside-only talker sweep of a far pair is
  distribution-identical to a full sweep of a nearer pair, so no single-pair
  statistic can detect under-coverage; the estimate is intrinsically a lower
  bound and the implementation documents this. Layout stress across 3+
  devices is the cross-check that exposes under-estimated pairs. Drift
  correction applies only when the Theil–Sen slope clears its own noise
  floor (2σ), since subtracting an insignificant slope estimated from the
  geometric spread distorts more than short-window SRO does.

- `source-locator.ts` — for 3+ devices with a current layout: coarse grid +
  local refinement over bias-corrected per-event TDOAs → talker position
  hint with residual.
- `engine.ts` — `ReconciliationEngine` (host-side orchestrator, injected
  clock for tests): ingests local + remote voice events and motion-stability
  signals, clusters via `deriveReconciledAudioEvents`, feeds the
  accumulators, and produces a `ReconciliationSnapshot`:

  ```ts
  { ranges: PairRangeEstimate[], layout: ConstellationLayout | null,
    talker: SourceHint | null, updatedAtHostEpochMs }
  ```

  Motion handling: observations inside ±1 s of a motion spike are discarded;
  sustained movement of a device clears that device's pair histories
  (the geometry changed; the bias did not, but the τ interval did).

### 3. Host wiring + broadcast (`waveform-app.tsx`, `use-webrtc-room.ts`)

- Every device passes `getVoiceEvent` into `useWebRtcRoom`; host receives
  peers' events via `onVoiceEvent`.
- Host runs the engine (recompute ~1 Hz) and broadcasts a compact
  `reconciliation-state` message (ranges + layout points + talker hint) so
  every phone renders the same picture.
- UI panel under the waveform rows: per-pair distance with confidence and
  "≥" lower-bound marker while coverage is poor, a small 2D constellation
  canvas (3+ devices), and a fading talker dot when localized. Includes a
  hint ("walk and talk around the phones") because the method physically
  requires source diversity.

## Error budget and gating (why this will be precise)

- GCC-PHAT per-frame scatter in furnished rooms: ~1–3 samples at 48 kHz
  equivalent (0.7–2 cm) for good frames; quality gates (PHAT peak, peak
  ratio ≥ ~1.5, correlation floor) drop the heavy-tailed reverberant
  outliers; the density filter and percentile extremes absorb the rest.
- Clock sync error and pipeline latency: absorbed into Δ̂ (midpoint) — not a
  distance error source.
- ADC sample-rate offset: removed by the Theil–Sen drift fit.
- Device movement: motion-stability gating + pair resets.
- Capture processing (AEC/NS/AGC distort timing): v2 already exposes capture
  modes and verifies raw capture; reconciliation weighs events by the
  existing timing confidence.

## Testing

- Unit tests (vitest, colocated `*.test.ts`) for each new module, TDD:
  synthetic τ distributions with known d/Δ/drift for the accumulator;
  synthetic band-limited noise through the real
  `captureAudioSnippet`/`estimateRawAudioOffset` path with known fractional
  delays for the observation extractor; deterministic engine tests with a
  scripted talker.
- End-to-end simulation test: 2 and 3 devices at known positions in a
  4×5 m room, talker positions sweeping the room, signals synthesized with
  true propagation delays + per-device clock bias + SRO drift; assert
  distance error ≤ 15 cm and layout pair error bounds after convergence.
- `npm run test`, plus `npm run build` to confirm Next compatibility.

## Out of scope (later goals, hooks left in place)

- Active chirp fusion (BeepBeep round-trip calibrates Δ to ~1 cm instantly;
  `PairRangeEstimate.biasMs` is exactly the quantity it would pin down).
- Joint nonlinear refinement over {positions, sources, offsets}
  (Hennecke & Fink-style batch NLS) — the engine's data layout supports it.
- Server-side persistence of reconciliation output.
