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

The first detector is now a normalized matched filter over a rolling local audio window. The observer synthesizes the expected pulse template from the advertised start frequency, end frequency, duration, and sample rate, scans a bounded recent sample window, and requires both a minimum correlation score and a peak-ratio guard before preserving the detected sample index. A host-estimated timestamp still travels with the observation for ordering and UI freshness, but distance estimation uses the sample index. This is still simpler than a full GCC-PHAT pipeline, but it is a major step beyond raw mic-level thresholding because the observation is tied to the actual matched sample offset.

The capture path now prefers an `AudioWorkletProcessor` that posts render-quantum sample chunks tagged with `currentFrame` into a one-second rolling buffer. The Web Audio spec's default render quantum is 128 sample frames, so this is much closer to continuous sample history than animation-frame polling. Worklet chunks also feed a streaming chirp matcher immediately when a self or peer pulse is active; if worklet registration fails, the app falls back to the analyser snapshot path and keeps the same `audioWindow` interface.

The session layer now treats pulses and observations as histories, not a single mutable fact. Each device keeps a bounded recent sequence of sanitized acoustic pulses or pulse observations keyed by pulse id. Room ranging pairs reciprocal chirp exchanges between two phones, measures both elapsed intervals inside each phone's own sample clock, converts those intervals to seconds, and estimates distance with the ETOA equation `meters = 343 / 2 * (deltaASeconds - deltaBSeconds)`. Host timestamps no longer create ranges directly; a one-way observation without reciprocal sample anchors is ignored. The returned range still carries `pulseIds`, `samplesUsed`, timing uncertainty, distance uncertainty, and the latest observed host timestamp for freshness. This is the beginning of the reconciliation path needed for meeting audio: network transport can lag, but the metadata still preserves when the audio event happened.

The deployed app now also has a speech-event reconciliation ledger. Each phone can emit a lightweight voice/energy edge with sample index, audio context time, host-aligned detection time, audio level, confidence, and clock uncertainty. The room state keeps bounded per-device voice histories and projects near-simultaneous detections into reconciled audio events with arrival leader, participating devices, timing spread, observations, and confidence. This does not yet stream full speech audio or solve diarization; it creates the real-time metadata spine needed to later run GCC-PHAT/cross-correlation over retained audio windows and decide where a spoken event arrived first.

Speech events now also carry a compact, privacy-preserving audio fingerprint: a 32-bin normalized energy contour over a 240 ms window around the voice edge, plus a small signed alignment sketch. The room reconciler cross-correlates matching fingerprints to estimate per-device audio offsets and writes `refinedDetectedAtHostEpochMs`, `fingerprintOffsetMs`, `fingerprintCorrelation`, and `fingerprintAlignmentConfidence` into the audio event. When both sides have the signed sketch, the estimator prefers that finer-hop path; otherwise it falls back to the energy contour. The TDOA source fitter prefers those refined timestamps when available. This is not diarization and it is not raw audio streaming; it is the first small feature vector that lets the system realign from captured sound history when clock-only alignment is imperfect.

The visual layer now converts those reconciled audio events into source hints. A source hint is projected just beyond the earliest-arrival device, away from later-arrival observers, and fades with event age. This is deliberately conservative: it says "the sound likely came from this side of the device constellation" instead of claiming a precise speaker coordinate before cross-device waveform correlation exists.

When at least three devices observe the same speech event, the visual layer now tries a TDOA grid fit over the solved phone constellation. Candidate source points are scored by how closely their predicted sound-travel time differences match the observed host-aligned arrival differences, weighted by event confidence and clock uncertainty. The result carries a residual error and remains confidence-scored; two-device or weak geometry still falls back to the leader-side hint.

The live calibration loop now rotates emitters across all active room devices using deterministic host-clock slots. Each phone can independently compute the same upcoming emitter from room membership and host time; only that emitter schedules the chirp, while every phone, including the emitter, tracks the currently valid pulse. Chirp playback now reuses one `AudioContext` and schedules oscillators with `oscillator.start(contextTime)` on the audio clock rather than creating a new context and firing immediately from a JavaScript timer. Scheduled pulse times are used only to aim the detector. Ranging requires the emitter's microphone to self-record its own chirp and publish that detected sample index before an exchange can become a distance. This keeps the BeepBeep/ETOA equation anchored to arrivals in each device's recording stream instead of mixing in output-scheduler estimates.

Calibration events now bypass the slow periodic heartbeat path. When a device schedules a chirp or detects a peer chirp, it immediately flushes the latest calibration payload to the room store, then the normal heartbeat continues carrying sensor state and deduped event history. Devices also poll room state faster while listening and relax back before sensors start. This keeps Redis-backed polling simple while shaving event propagation latency.

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

This is not yet the final detector. The next detector should move more matching work into the worklet, adapt chirp parameters to device response, and add GCC-PHAT-style cross-correlation over longer rolling history.
