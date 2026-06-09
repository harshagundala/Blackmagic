# Blackmagic

Blackmagic is a browser-native research app for turning a cluster of nearby phones into a relative acoustic constellation. V1 focuses on the first believable slice: URL-based host/phone rooms, explicit sensor permission flow, clock-synced sensor heartbeats, and the acoustic primitives needed for pairwise ranging.

## Current V1

- Next.js 16 App Router, React 19, TypeScript, Tailwind CSS.
- Near-wordless Apple-like mobile UI: the deployment URL is the room, the first phone is host, later phones join nearby.
- Browser sensor acquisition hook for mic level, sample rate, motion/orientation, and geolocation accuracy.
- Host-clock sync model plus per-audio-frame timestamp metadata: sample index, sample rate, audio context time, performance origin, host-estimated epoch, offset, jitter, best RTT, max error, and uncertainty.
- URL-based room claim: first device is host, later devices are nearby phones.
- Polling room heartbeat for active device presence, sensor status, clock quality, and audio-frame timing metadata.
- Active acoustic pulse metadata: hosts publish scheduled ultrasonic-ish pulses, peers run matched detection over a short audio sample window, report host-aligned observations, and room state derives pairwise meter ranges.
- Minimal constellation dots are now layout-driven from acoustic ranges when present, with radial fallback before measurements arrive.
- Stale hosts are released so the next active device can become host instead of leaving the room pinned forever.
- Session APIs use a `SessionStore` abstraction: Upstash Redis via Vercel Marketplace env when configured, in-memory fallback when not.
- Tested acoustic delay primitives and distance conversion.
- Tested pairwise calibration planner with robust median/outlier handling.
- Tested 2D weighted stress minimization for relative phone layout.
- Provider seam for production realtime; app runs in demo mode without credentials.

## Research Direction

The core V1 assumption is active acoustic calibration, not passive GPS/gyro inference. Each phone should eventually play and record short chirps in pairwise slots, estimate sample offsets on-device, exchange derived ranges, reject outliers, and solve a 2D layout. See `docs/research/blackmagic-v1-technical-brief.md`.

Audio timing is treated as sample-domain truth. Browser/network clocks are synchronized continuously as a coarse host-time prior with explicit uncertainty, then audio events are mapped through a Web Audio context-time/performance-time anchor so historical samples are not collapsed to heartbeat delivery time. Every active mic heartbeat can now carry an audio-frame stamp and a short local audio window for on-device pulse detection; acoustic pulse observations turn those stamps into same-room range hints with meter-level uncertainty. Localization should ultimately realign recordings by sample indices and audio cross-correlation.

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

## Realtime And Presence

Vercel hosts the app, HTTPS sensor permission surface, URL session pages, and token APIs. Persistent realtime should live in a provider such as Ably, with WebRTC/TURN added for reliable media/data channels. Without `ABLY_API_KEY`, `/api/realtime/config` reports demo mode.

Room presence is server-polled today. In production, set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from a Vercel Marketplace Redis integration to make host claims and sensor presence durable across serverless instances. Without those variables, the app keeps the local in-memory store for development and demo deployments.

Durable polling is still not the final realtime layer. The next step is pushing the same heartbeat/timing payloads over realtime pub/sub so phones see each other with lower latency.

Suggested Vercel Marketplace Redis install after accepting Upstash terms:

```bash
vercel integration add upstash/upstash-kv \
  --plan free \
  --name blackmagic-presence \
  -m primaryRegion=iad1 \
  -m prodPack=false \
  -m autoUpgrade=false \
  -e production -e preview -e development
```
