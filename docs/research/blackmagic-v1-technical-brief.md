# Blackmagic V1 Technical Brief

Blackmagic V1 should feel like passive magic, but the measurement primitive should be active acoustic calibration. Browser-visible iPhone sensors are useful, but none of GPS, compass, accelerometer, gyroscope, or app-level network timestamps can reliably solve same-room relative geometry alone.

## What V1 Uses

- Web Audio microphone capture with `getUserMedia()` and raw-ish constraints where the browser honors them.
- Pairwise chirp calibration inspired by BeepBeep / elapsed time of arrival ranging: measure sample offsets on the same device clock and avoid JavaScript clock sync.
- Matched filtering / GCC-PHAT-style delay detection as the detector layer.
- Robust repeated measurements: median range selection, confidence weighting, and outlier rejection.
- Weighted 2D stress minimization for the relative phone constellation.
- Motion/orientation/geolocation as weak UX and confidence signals, not primary geometry.

## Research Anchors

- BeepBeep: high accuracy acoustic ranging with commodity phones, Microsoft Research: https://www.microsoft.com/en-us/research/publication/beepbeep-a-high-accuracy-acoustic-ranging-system-using-cots-mobile-devices/
- Indoor acoustic localization survey and ETOA framing: https://link.springer.com/article/10.1186/s13673-019-0207-4
- GCC-PHAT foundation, Knapp and Carter generalized correlation: https://cir.nii.ac.jp/crid/1362825894985623680?lang=en
- Smartphone acoustic TDOA reflection caveats: https://www.mdpi.com/1999-5903/15/7/240
- MDN `getUserMedia()` privacy and secure-context requirements: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN media constraint best-effort behavior: https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation
- MDN DeviceOrientation permission model: https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static
- Vercel realtime guidance and WebSocket limitation: https://vercel.com/docs/solutions/realtime and https://vercel.com/docs/limits#websockets

## Realtime Architecture Decision

Vercel hosts the Next.js app, HTTPS sensor permission surface, QR/session routes, and short-lived provider token endpoints. It should not be the persistent WebSocket server. Production realtime should use Ably by default, with WebRTC data/audio channels for peer media and TURN for reliable NAT traversal.

The current repository keeps that provider seam explicit through `src/lib/realtime/contracts.ts` and `/api/realtime/config`. Without provider credentials the app runs in demo mode and exercises the same calibration/positioning code paths.
