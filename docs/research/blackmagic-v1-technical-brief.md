# Blackmagic V1 Technical Brief

Blackmagic V1 should feel like passive magic, but the measurement primitive should be active acoustic calibration. Browser-visible iPhone sensors are useful, but none of GPS, compass, accelerometer, gyroscope, or app-level network timestamps can reliably solve same-room relative geometry alone.

## What V1 Uses

- Web Audio microphone capture with `getUserMedia()` and raw-ish constraints where the browser honors them.
- Pairwise chirp calibration inspired by BeepBeep / elapsed time of arrival ranging: measure sample offsets on the same device clock and avoid JavaScript clock sync.
- Scheduled active pulse metadata: emitters publish future host-aligned pulse times; observers report detected pulse times with amplitude, confidence, and clock uncertainty.
- Matched filtering / GCC-PHAT-style delay detection as the detector layer.
- Robust repeated measurements: median range selection, confidence weighting, and outlier rejection.
- Weighted 2D stress minimization for the relative phone constellation.
- Motion/orientation/geolocation as weak UX and confidence signals, not primary geometry.
- Sample-domain timestamp metadata for every audio frame/event, with network clock sync used only as a confidence-scored host-time prior.

## Research Anchors

- BeepBeep: high accuracy acoustic ranging with commodity phones, Microsoft Research: https://www.microsoft.com/en-us/research/publication/beepbeep-a-high-accuracy-acoustic-ranging-system-using-cots-mobile-devices/
- Indoor acoustic localization survey and ETOA framing: https://link.springer.com/article/10.1186/s13673-019-0207-4
- GCC-PHAT foundation, Knapp and Carter generalized correlation: https://cir.nii.ac.jp/crid/1362825894985623680?lang=en
- Smartphone acoustic TDOA reflection caveats: https://www.mdpi.com/1999-5903/15/7/240
- MDN `getUserMedia()` privacy and secure-context requirements: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN media constraint best-effort behavior: https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation
- MDN DeviceOrientation permission model: https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static
- MDN DeviceMotion event interval / acceleration / rotation-rate model: https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/interval
- MDN Geolocation coordinates and accuracy fields: https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates
- W3C High Resolution Time monotonic clock and `performance.timeOrigin`: https://w3c.github.io/hr-time/
- Web Audio API `AudioContext.getOutputTimestamp()` context/performance-time bridge: https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp
- AudioWorklet `currentFrame` sample-frame counter: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope/currentFrame
- NTPv4 offset, delay, jitter, and clock-filter framing: https://datatracker.ietf.org/doc/html/rfc5905
- GCC-PHAT / TDOA speaker-localization baseline: https://www.isca-archive.org/interspeech_2021/salvati21_interspeech.pdf
- rVAD unsupervised robust voice-activity direction: https://arxiv.org/abs/1906.03588
- Vercel realtime guidance and WebSocket limitation: https://vercel.com/docs/solutions/realtime and https://vercel.com/docs/limits#websockets

## Realtime Architecture Decision

Vercel hosts the Next.js app, HTTPS sensor permission surface, URL session routes, and short-lived provider token endpoints. It should not be the persistent WebSocket server. Production realtime should use Ably by default, with WebRTC data/audio channels for peer media and TURN for reliable NAT traversal.

The current repository keeps that provider seam explicit through `src/lib/realtime/contracts.ts` and `/api/realtime/config`. Without provider credentials the app runs in demo mode and exercises the same calibration/positioning code paths.

The deployed V1 now also exposes polling endpoints:

- `/api/session/claim`: first device at a URL becomes host; subsequent devices become phones.
- `/api/session/heartbeat`: publishes low-rate sensor, clock quality, audio-frame timestamp, latest acoustic pulse, and latest acoustic observation summaries.
- `/api/session/state`: reads active room devices, prunes stale phones, preserves bounded acoustic pulse/observation histories, and derives acoustic range hints from matched pulse metadata.
- `/api/session/readiness`: reports whether production room state is backed by durable Redis or degraded to process-local memory.

The room API is backed by a `SessionStore` abstraction. With Vercel Marketplace Redis env (`KV_REST_API_URL` and `KV_REST_API_TOKEN`), it stores host claims and device heartbeats in Upstash Redis over REST. The older direct Upstash env names are still accepted for manual setups. Without durable Redis variables, it falls back to an in-memory store for local development and demos.

This is intentionally a stepping stone. Durable Redis-backed polling makes room state independent of a single serverless runtime, but production rooms should still move to realtime pub/sub transport so nearby phones receive presence, timing, and calibration updates with lower latency.

## Timestamp Reconciliation

Localization cannot depend on `Date.now()`, WebSocket delivery time, or server receive time. Audio metadata must carry:

- device id;
- audio sample index;
- sample rate;
- `AudioContext.currentTime`;
- client performance-time origin;
- local `performance.now()`;
- host-estimated epoch time for the audio frame;
- current host-clock offset estimate;
- clock uncertainty / round-trip confidence;
- a compact timing confidence score derived from clock uncertainty, best round trip, jitter, offset stability, and accepted sample count.

The clock model should run continuously using low-RTT echo exchanges, but the sample index remains the strongest timestamp inside a device recording. Network clock sync is a real-time alignment prior; offline or near-real-time reconciliation should refine alignment by cross-correlating the actual audio history.

The deployed V1 now keeps a bounded, low-latency exchange history instead of trusting the latest echo. It exposes offset, best round trip, jitter, max error, sample count, and quality in the heartbeat. On start, the browser performs an immediate sync, a short warm-up burst, and then a 1s maintenance loop. This is still not enough for centimeter-grade acoustic localization by itself, but it makes the uncertainty explicit and keeps bad network samples from masquerading as precise audio timestamps.

The clock model now rejects offset outliers separately from high-RTT samples. This matters because a network exchange can look fast while still being asymmetric enough to imply the wrong device clock offset. Audio-frame timestamps also carry the clock model lineage used to create them: quality, max error, best round trip, jitter, accepted sample count, rejected outlier count, and offset stability. Downstream reconciliation can therefore decide whether a captured audio event is precise enough for localization instead of treating every timestamp as equally trustworthy.

For historical audio events, the app maps `sampleIndex / sampleRate` into the host timeline through a Web Audio `contextTime` plus `performanceTime` anchor. That means a detector can report "the pulse peaked 240 samples before the latest frame" and preserve the 5 ms offset in the host-estimated timestamp. At room scale, that 5 ms is about 1.7 m of sound travel, so this metadata is essential.

The timestamp path now carries that clock lineage through historical sample mapping, voice activity events, room storage, reconciled audio-event observations, and the TDOA source fitter. Each speech edge keeps the timing confidence attached to the audio frame that produced it; each reconciled event exposes `timestampUncertaintyMs` and aggregate `timingConfidence`; and precise TDOA fits are downweighted when the underlying capture clocks are weak. Network delivery can still lag, but late packets no longer erase when the sound actually hit each microphone.

## Sensor Fusion

The browser sensor layer now preserves quantitative motion, heading, and location metadata instead of just `active` or `blocked` flags. Device motion contributes acceleration axes, acceleration-with-gravity axes, rotation-rate axes, event interval, and a derived `motionStability` score. The score treats low dynamic acceleration and low rotation as stable; when only gravity-inclusive acceleration is available, it subtracts Earth gravity to estimate dynamic movement. That gives localization a simple real-time guardrail: an audio event from a phone being moved gets lower confidence than the same event from a still phone.

Orientation contributes heading, beta, gamma, and whether the reading is absolute. Geolocation contributes latitude, longitude, altitude, speed, heading, timestamp, and accuracy fields. GPS is intentionally treated as weak room context because same-room accuracy is usually too coarse, but preserving the accuracy metadata lets downstream fusion decide whether a reading is useful for coarse venue anchoring or should be ignored.

Motion stability now travels with voice events and reconciled audio observations, then downweights TDOA source hints. This is deliberately conservative: sensor data improves trust scoring before it tries to move points directly.

Motion stability now also protects the active acoustic map. If a device reports active, unstable movement, its pulse and observation history is cleared before range derivation. That prevents a phone picked up or rotated after calibration from continuing to publish old meter labels until the freshness timeout expires; it must settle and collect new reciprocal chirps before becoming a precise anchor again.

The first detector is now a normalized matched filter over a rolling local audio window. The observer synthesizes the expected pulse template from the advertised start frequency, end frequency, duration, and sample rate, scans a bounded recent sample window, and requires both a minimum correlation score and a peak-ratio guard before preserving the detected sample index. Candidate ranking now uses amplitude-weighted strength as a tie-breaker when two candidate chirps have similar normalized correlation, so a weak early candidate does not permanently steal the timestamp from a stronger same-pulse hit that arrives before the search horizon closes. A host-estimated timestamp still travels with the observation for ordering and UI freshness, but distance estimation uses the sample index. This is still simpler than a full GCC-PHAT pipeline, but it is a major step beyond raw mic-level thresholding because the observation is tied to the actual matched sample offset.

The capture path now prefers an `AudioWorkletProcessor` that posts render-quantum sample chunks tagged with `currentFrame` into a one-second rolling buffer. The Web Audio spec's default render quantum is 128 sample frames, so this is much closer to continuous sample history than animation-frame polling. Worklet chunks also feed a streaming chirp matcher immediately when a self or peer pulse is active; if worklet registration fails, the app falls back to the analyser snapshot path and keeps the same `audioWindow` interface.

The session layer now treats pulses and observations as histories, not a single mutable fact. Each device keeps a bounded recent sequence of sanitized acoustic pulses or pulse observations keyed by pulse id. Room ranging pairs reciprocal chirp exchanges between two phones, measures both elapsed intervals inside each phone's own sample clock, converts those intervals to seconds, and estimates distance with the ETOA equation `meters = 343 / 2 * (deltaASeconds - deltaBSeconds)`. Host timestamps no longer create ranges directly; a one-way observation without reciprocal sample anchors is ignored. The returned range still carries `pulseIds`, `samplesUsed`, timing uncertainty, distance uncertainty, and the latest observed host timestamp for freshness. This is the beginning of the reconciliation path needed for meeting audio: network transport can lag, but the metadata still preserves when the audio event happened.

The deployed app now also has a speech-event reconciliation ledger. Each phone can emit a lightweight voice/energy edge with sample index, audio context time, host-aligned detection time, audio level, confidence, and clock uncertainty. The room state keeps bounded per-device voice histories and projects near-simultaneous detections into reconciled audio events with arrival leader, participating devices, timing spread, observations, and confidence. This does not yet stream full speech audio or solve diarization; it creates the real-time metadata spine needed to later run GCC-PHAT/cross-correlation over retained audio windows and decide where a spoken event arrived first.

Speech events now also carry a compact, privacy-preserving audio fingerprint: a 32-bin normalized energy contour over a 240 ms window around the voice edge, plus a small signed alignment sketch. The room reconciler cross-correlates matching fingerprints to estimate per-device audio offsets and writes `refinedDetectedAtHostEpochMs`, `fingerprintOffsetMs`, `fingerprintCorrelation`, and `fingerprintAlignmentConfidence` into the audio event. When both sides have the signed sketch, the estimator prefers that finer-hop path; otherwise it falls back to the energy contour. The TDOA source fitter prefers those refined timestamps when available. This is not diarization and it is not raw audio streaming; it is the first small feature vector that lets the system realign from captured sound history when clock-only alignment is imperfect.

The visual layer now converts those reconciled audio events into source hints. A source hint is projected just beyond the earliest-arrival device, away from later-arrival observers, and fades with event age. This is deliberately conservative: it says "the sound likely came from this side of the device constellation" instead of claiming a precise speaker coordinate before cross-device waveform correlation exists.

When at least three devices observe the same speech event, the visual layer now tries a TDOA grid fit over the solved phone constellation. Candidate source points are scored by how closely their predicted sound-travel time differences match the observed host-aligned arrival differences, weighted by event confidence and clock uncertainty. The result carries a residual error and remains confidence-scored; two-device or weak geometry still falls back to the leader-side hint.

The live calibration loop now rotates emitters across all active room devices using deterministic host-clock slots. Each phone can independently compute the same upcoming emitter from room membership and host time; only that emitter schedules the chirp, while every phone, including the emitter, tracks the currently valid pulse. Chirp playback now reuses one `AudioContext` and schedules oscillators with `oscillator.start(contextTime)` on the audio clock rather than creating a new context and firing immediately from a JavaScript timer. Scheduled pulse times are used only to aim the detector. Ranging requires the emitter's microphone to self-record its own chirp and publish that detected sample index before an exchange can become a distance. This keeps the BeepBeep/ETOA equation anchored to arrivals in each device's recording stream instead of mixing in output-scheduler estimates.

Calibration events now bypass the slow periodic heartbeat path. When a device schedules a chirp or detects a peer chirp, it immediately flushes the latest calibration payload to the room store, then the normal heartbeat continues carrying sensor state and deduped event history. Observers select pulses from that bounded history, not only the latest heartbeat field, so a normal heartbeat that clears the latest pulse cannot erase an observable chirp before nearby phones poll the room. The selector skips pulse ids the current phone has already recorded with a sample-domain anchor, which keeps the detector advancing through the calibration sequence without letting weak legacy timestamp-only observations block a retry. Same-pulse observations can still be republished when a later sample-anchored candidate is meaningfully stronger; the flush key includes the detected sample so the improved timestamp is not suppressed as an immediate duplicate. Devices poll room state faster while listening and relax back before sensors start. This keeps Redis-backed polling simple while shaving event propagation latency.

The visual constellation weights range edges by confidence, repeated sample count, and distance uncertainty. One noisy chirp can still produce a hint, but repeated low-uncertainty reciprocal observations pull the layout more strongly and show as higher-confidence motion. Live room state now also treats range evidence as fresh, not permanent: if a reciprocal chirp range is older than the active freshness window, it stops contributing coordinates or meter labels until another sample-domain exchange refreshes it. The rendered field is then transformed into the current phone's perspective: the local device is always the origin, source hints move through the same transform as phones, and available heading rotates the room so the display is relative to the direction the phone is pointing rather than pinned to the host.

## Active Pulse Ranging

The current V1 range path is intentionally conservative:

1. A deterministic host-clock slot selects one active room device as the emitter.
2. The selected device schedules a short 17.2-19.2 kHz chirp slightly in the future using its current host-clock model.
3. The emitter publishes the pulse id, intended host epoch, start frequency, end frequency, and duration through the normal heartbeat. It does not claim a sample-domain emission anchor until its microphone hears the chirp.
4. Every phone, including the emitter, matches the pulse template inside a bounded recent audio sample window and publishes the detected sample index, host-estimated detected time, amplitude, confidence, and clock uncertainty.
5. The room state waits for a reciprocal two-pulse exchange with four detected sample anchors: A hears A, A hears B, B hears A, and B hears B.
6. The room state derives `meters = 343 / 2 * (deltaASeconds - deltaBSeconds)` using only same-device sample intervals, rejects negative or implausibly large propagation, and aggregates repeated exchanges with outlier-aware confidence.
7. The room state expires old range evidence before it drives live localization, so a phone that moves or misses fresh chirps falls back to a low-confidence marker instead of keeping a stale precise distance.

This is not yet the final detector. The next detector should move more matching work into the worklet and adapt chirp parameters to device response.

## V1.1 Hardening

The stack was audited and hardened end to end. The changes, in dependency order:

**Detection precision.** The matched filter now scores the correlation envelope using an in-phase plus quadrature template pair instead of the raw carrier. Near Nyquist the real correlation of the 17.2–19.2 kHz chirp oscillates at the carrier period, and the integer peak could lock onto a neighboring carrier cycle (~2.6 samples ≈ 1.9 cm of error) or miss entirely under the carrier phase shifts device processing applies; envelope scoring removes both failure modes. A parabolic vertex fit then refines every peak to sub-sample resolution, and fractional sample indices survive the whole pipeline: streaming matcher, observation publishing, registry sanitization (three-decimal sample indices), and the ETOA ranging math.

**Clock honesty.** `/api/time/echo` returns a per-process `serverInstanceId`; the clock model groups exchanges by instance and models only the dominant one, because serverless instances have different `Date.now()` baselines. The model fits a drift slope (ms/s) over the exchange history when it spans enough time, and `projectClockModel()` ages any model to "now": drift moves the offset, staleness honestly widens the bounds. `uncertaintyMs` (one-sigma style) and `maxErrorMs` (best half round trip plus twice the scatter) are now distinct. Every audio timestamping site uses the projected model, and the detector search window widens with the projected error bound so a wrong clock cannot push a chirp outside the search range.

**Honest ranging uncertainty.** Reciprocal ETOA cancels host-clock offset error by construction, so the range uncertainty now reports the terms that actually apply: residual sub-sample quantization, audio-crystal rate mismatch across the reciprocal turn interval (the dominant term — 50 ppm over a 5 s turn is ±0.25 ms ≈ 8.6 cm, so uncertainty now grows with turn time), and detection quality scaled by the correlation envelope width.

**Raw-audio reconciliation (GCC-PHAT).** Voice events now carry a compact raw snippet: 240 ms around the edge, band-limited and decimated to 8 kHz, peak-normalized, 8-bit quantized, base64 encoded (~2.6 KB). The room reconciler decodes matching snippets and runs FFT-based GCC-PHAT with phase-transform whitening and parabolic sub-sample refinement; when the Pearson correlation at the aligned lag holds, the raw-audio offset supersedes both fingerprint alignment and clock-based timestamps in `refinedDetectedAtHostEpochMs`, which the TDOA source fitter already prefers. Snippets are server-side evidence only: API responses strip them (`compactRoomStateForTransport`). This moves dialogue localization from clock-error-bounded (±meters) to waveform-alignment-bounded (sub-millisecond on clean speech, validated under synthetic reverb and noise).

**Constellation stability.** The solved layout is rotation/reflection-aligned to the previous frame with a weighted 2D Procrustes fit (anchor pinned, mirrored fit chooses reflection), so the constellation can no longer flip or spin between solves; adaptive damping suppresses sub-noise movement (a 1% range wobble no longer renders as a jump) while real movement passes through. Two-device rooms get a deterministic explicit path: distance from the weighted ranges, direction held from the previous frame. The solver early-stops on convergence.

**Geometric consistency.** Pairwise acoustic ranges are now checked as a room graph before they become UI coordinates. If three or more range edges create a high-stress, physically impossible constellation, the visual adapter removes the weakest edge whose removal materially improves the solve. This keeps a single bad reciprocal exchange from making Blackmagic draw confident phone positions or peer distance labels that violate basic geometry.

**Research simulation.** The repository now includes a deterministic acoustic-room simulator under `src/lib/research`. It starts from physical phone coordinates, synthesizes reciprocal chirp pulses and sample-domain observations for every pair, feeds them through the same `SessionRegistry` / ETOA ranging / constellation solver path used by the app, and reports maximum range and layout-pair error. It can also inject spoken-source events at known coordinates, publish per-phone voice arrivals through the registry, and score the resulting TDOA source hint by source-to-phone distance error. Every simulation now carries a physical-room validation report that classifies phone layout, raw audio-capture readiness, audio-timestamp readiness, and spoken-source readiness from track processing settings, audio-context state, clock health, sample-domain audio-frame evidence, range coverage, layout stress, and TDOA residuals. The capture gate distinguishes confirmed raw capture, unreported browser processing flags, and explicitly filtered capture, so iPhone trials can fail as warming/unverified instead of falsely blaming Safari for filtering it did not report. `npm run trial:simulate -- --out artifacts/simulated-evidence.json` runs that deterministic room through the same evidence gates and should pass before a live room attempt. The live report is exposed at `/api/session/validation?url=<session-url>` so an iPhone trial can query readiness without adding UI controls; it now includes per-device diagnostics for mic state, capture processing, audio context state, sample-rate evidence, timestamp precision, motion stability, localization status, distance estimate, and exact per-phone blockers. `npm run trace:validation -- <session-url> --out artifacts/trial.ndjson --evidence-out artifacts/trial-evidence.json` polls that endpoint and writes an NDJSON trace plus a compact evidence packet containing the session URL, sample window, final validation state, sustained-ready gate, minimum-device gate, localized-device gate, acoustic-range gate, audio-capture gate, audio-timestamp gate, TDOA-source gate, and per-device blocker history. The same packet can be regenerated offline from a saved trace with `--from artifacts/trial.ndjson`. This gives the lab a repeatable pre-iPhone gate for changes to calibration, history aggregation, source localization, raw capture, timestamp precision, and layout trust.

**Transport.** The Redis host claim is strictly SETNX-with-retry — the plain-SET fallback that let two racing devices both become host is gone. Stale-device pruning re-reads each candidate immediately before deletion so a device that heartbeats mid-prune is not ghosted. The client runs a single long-poll loop (the server-side timeout doubles as the idle refresh) with exponential backoff and a surfaced connection state, instead of a redundant interval poll alongside it. An emitter now publishes its pulse advertisement first and only commits to playing the chirp after the server acknowledged the advertisement with enough remaining lead; unacknowledged advertisements retry, and late ones skip the slot rather than chirping into a room where nobody is listening.

Session URLs are now accepted only as absolute `http:` or `https:` URLs before they reach claim, heartbeat, state, wait, or validation storage paths. That keeps malformed trial links and non-web schemes from becoming Redis namespaces or long-poll work during field tests; missing URLs still report `missing_url`, while malformed URLs report `invalid_url`.

**iOS lifecycle.** After `getUserMedia`, the app reads `track.getSettings()` and records whether echo cancellation, noise suppression, and auto-gain are confirmed off, unknown, or explicitly on. Confirmed processing still surfaces as the quiet `filtered mic` warning because iOS voice processing can attenuate the chirp band; unknown reporting keeps validation warming without adding more visible chrome. The audio context resumes on `statechange` and on visibility return, a screen wake lock keeps passive sessions alive, mic-track loss is surfaced, the clock re-syncs immediately when the tab returns from background throttling, and the room state resyncs on visibility. Emitter rotation now skips devices that are not actively capturing (mic blocked or context suspended), since a device that cannot self-record its chirp guarantees a wasted exchange.

**Demo surface.** The UI keeps the quiet-instrument language and adds: a whispered status line (peer presence, live/reconnecting, sync error in ms, filtered-mic warning), a breathing origin dot for the local device, and voice blooms — reconciled audio events rendered as ink-drop radiants on the side of the room the voice came from, fading with event age.
