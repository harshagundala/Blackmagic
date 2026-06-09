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
- W3C High Resolution Time monotonic clock and `performance.timeOrigin`: https://w3c.github.io/hr-time/
- Web Audio API `AudioContext.getOutputTimestamp()` context/performance-time bridge: https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp
- NTPv4 offset, delay, jitter, and clock-filter framing: https://datatracker.ietf.org/doc/html/rfc5905
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
- clock uncertainty / round-trip confidence.

The clock model should run continuously using low-RTT echo exchanges, but the sample index remains the strongest timestamp inside a device recording. Network clock sync is a real-time alignment prior; offline or near-real-time reconciliation should refine alignment by cross-correlating the actual audio history.

The deployed V1 now keeps a bounded, low-latency exchange history instead of trusting the latest echo. It exposes offset, best round trip, jitter, max error, sample count, and quality in the heartbeat. On start, the browser performs an immediate sync, a short warm-up burst, and then a 1s maintenance loop. This is still not enough for centimeter-grade acoustic localization by itself, but it makes the uncertainty explicit and keeps bad network samples from masquerading as precise audio timestamps.

For historical audio events, the app maps `sampleIndex / sampleRate` into the host timeline through a Web Audio `contextTime` plus `performanceTime` anchor. That means a detector can report "the pulse peaked 240 samples before the latest frame" and preserve the 5 ms offset in the host-estimated timestamp. At room scale, that 5 ms is about 1.7 m of sound travel, so this metadata is essential.

The first detector is now a normalized matched filter over a rolling local audio window. The observer synthesizes the expected pulse template from the advertised start frequency, end frequency, duration, and sample rate, scans the recent sample window, and requires both a minimum correlation score and a peak-ratio guard before converting the detected sample index into host time. This is still simpler than a full GCC-PHAT pipeline, but it is a major step beyond raw mic-level thresholding because the observation is tied to the actual matched sample offset.

The capture path now prefers an `AudioWorkletProcessor` that posts render-quantum sample chunks tagged with `currentFrame` into a one-second rolling buffer. The Web Audio spec's default render quantum is 128 sample frames, so this is much closer to continuous sample history than animation-frame polling. Worklet chunks also feed a streaming chirp matcher immediately when a peer pulse is active; if worklet registration fails, the app falls back to the analyser snapshot path and keeps the same `audioWindow` interface.

The session layer now treats pulses and observations as histories, not a single mutable fact. Each device keeps a bounded recent sequence of sanitized acoustic pulses or pulse observations keyed by pulse id. Room ranging first reconstructs each raw pulse/observation delay in host time, then groups by device pair, rejects low-confidence/outlier samples, confidence-weights the remaining distances, and returns `pulseIds`, `samplesUsed`, timing uncertainty, distance uncertainty, and the latest observed host timestamp. This is the beginning of the reconciliation path needed for meeting audio: network transport can lag, but the metadata still preserves when the audio event happened.

The live calibration loop now rotates emitters across all active room devices using deterministic host-clock slots. Each phone can independently compute the same upcoming emitter from room membership and host time; only that emitter schedules the chirp, while every other phone tracks the currently valid peer pulse. This makes non-host phone-to-phone ranges possible without exposing any extra controls.

Calibration events now bypass the slow periodic heartbeat path. When a device schedules a chirp or detects a peer chirp, it immediately flushes the latest calibration payload to the room store, then the normal heartbeat continues carrying sensor state and deduped event history. Devices also poll room state faster while listening and relax back before sensors start. This keeps Redis-backed polling simple while shaving event propagation latency.

The visual constellation weights range edges by confidence, repeated sample count, and distance uncertainty. One noisy chirp can still produce a hint, but repeated low-uncertainty reciprocal observations pull the layout more strongly and show as higher-confidence motion.

## Active Pulse Ranging

The current V1 range path is intentionally conservative:

1. A deterministic host-clock slot selects one active room device as the emitter.
2. The selected device schedules a short 17.2-19.2 kHz chirp slightly in the future using its current host-clock model.
3. The emitter publishes the pulse id, intended host epoch, start frequency, end frequency, and duration through the normal heartbeat.
4. Peers that match the pulse template inside their recent audio sample window publish observations with host-aligned detected time, amplitude, confidence, and clock uncertainty.
5. The room state derives `meters = propagationMs / 1000 * 343`, carries `distanceUncertaintyMeters` from the clock model, and rejects negative or implausibly late observations.
6. Repeated observations for the same phone pair are aggregated into one range with `samplesUsed`, contributing `pulseIds`, and outlier-aware confidence.

This is not yet the final detector. The next detector should move more matching work into the worklet, adapt chirp parameters to device response, and add GCC-PHAT-style cross-correlation over longer rolling history.
