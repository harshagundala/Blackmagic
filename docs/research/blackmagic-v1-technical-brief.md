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
- `/api/session/heartbeat`: publishes low-rate sensor, clock quality, audio-frame timestamp, acoustic pulse, and acoustic observation summaries.
- `/api/session/state`: reads active room devices, prunes stale phones, and derives acoustic range hints from matched pulse/observation metadata.

The room API is backed by a `SessionStore` abstraction. With `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, it stores host claims and device heartbeats in Upstash Redis over REST, which matches Vercel Marketplace's current Redis path. Without those variables, it falls back to an in-memory store for local development and demos.

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

The first detector is now a normalized matched filter over a short local audio window. The observer synthesizes the expected pulse template from the advertised frequency, duration, and sample rate, scans the recent sample window, and requires both a minimum correlation score and a peak-ratio guard before converting the detected sample index into host time. This is still simpler than a full chirp/GCC-PHAT pipeline, but it is a major step beyond raw mic-level thresholding because the observation is tied to the actual matched sample offset.

## Active Pulse Ranging

The current V1 range path is intentionally conservative:

1. The host schedules a short 18.5 kHz pulse slightly in the future using its current host-clock model.
2. The host publishes the pulse id, intended host epoch, frequency, and duration through the normal heartbeat.
3. A peer that matches the pulse template inside its recent audio sample window publishes an observation with its host-aligned detected time, amplitude, confidence, and clock uncertainty.
4. The room state derives `meters = propagationMs / 1000 * 343`, carries `distanceUncertaintyMeters` from the clock model, and rejects negative or implausibly late observations.

This is not yet the final detector. The next detector should move the sample window into an `AudioWorklet`, use a more robust chirp template, and add GCC-PHAT-style cross-correlation over longer rolling history so observations are not missed by animation-frame polling latency.
