# Blackmagic

Blackmagic is a browser-native research app for turning a cluster of nearby phones into a relative acoustic constellation. V1 focuses on the first believable slice: URL-based host/phone rooms, explicit sensor permission flow, clock-synced sensor heartbeats, and the acoustic primitives needed for pairwise ranging.

## Current V1

- Next.js 16 App Router, React 19, TypeScript, Tailwind CSS.
- Near-wordless Apple-like mobile UI: the deployment URL is the room, the first phone is host, later phones join nearby.
- Browser sensor acquisition hook for mic level, sample rate, motion/orientation, and geolocation accuracy.
- Host-clock sync model plus per-audio-frame timestamp metadata: sample index, sample rate, audio context time, performance origin, host-estimated epoch, and uncertainty.
- URL-based room claim: first device is host, later devices are nearby phones.
- Polling room heartbeat for active device presence, sensor status, clock quality, and audio-frame timing metadata.
- Stale hosts are released so the next active device can become host instead of leaving the room pinned forever.
- Tested acoustic delay primitives and distance conversion.
- Tested pairwise calibration planner with robust median/outlier handling.
- Tested 2D weighted stress minimization for relative phone layout.
- Provider seam for production realtime; app runs in demo mode without credentials.

## Research Direction

The core V1 assumption is active acoustic calibration, not passive GPS/gyro inference. Each phone should eventually play and record short chirps in pairwise slots, estimate sample offsets on-device, exchange derived ranges, reject outliers, and solve a 2D layout. See `docs/research/blackmagic-v1-technical-brief.md`.

Audio timing is treated as sample-domain truth. Browser/network clocks are synchronized continuously as a coarse host-time prior with explicit uncertainty. Every active mic heartbeat can now carry an audio-frame stamp, but localization should ultimately realign recordings by sample indices and audio cross-correlation.

## Commands

```bash
npm run dev
npm test
npm run lint
npm run build
```

Production preview:

```bash
npm run build
npm run start
```

## Realtime

Vercel should host the app, HTTPS permission surface, QR/session pages, and token APIs. Persistent realtime should live in a provider such as Ably, with WebRTC/TURN added for reliable media/data channels. Without `ABLY_API_KEY`, `/api/realtime/config` reports demo mode.

Current room state uses server-side polling APIs as a providerless stepping stone. Production-grade multi-device rooms still need durable realtime storage/transport so host claims and sensor presence survive serverless instance movement.
