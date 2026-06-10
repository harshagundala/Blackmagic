# Blackmagic

Blackmagic is a browser-native research app for turning a cluster of nearby phones into a relative acoustic constellation. V1 focuses on the first believable slice: URL-based host/phone rooms, explicit sensor permission flow, clock-synced sensor heartbeats, and the acoustic primitives needed for pairwise ranging.

## Current Main App: Waveform Plumbing Lab

The main routes currently render `WaveformApp`: every phone shows a live mic waveform for **every** connected phone, all drawn on the shared host-clock timeline. This proves the foundation visibly — capture, direct WebRTC links (host as hub), and sync precision (a clap aligns across rows; per-device `±Xms` badges show clock error against the host). The chirp/localization stack below remains in the tree and re-mounts once the plumbing is trusted.

## Current V1

- Next.js 16 App Router, React 19, TypeScript, Tailwind CSS.
- Near-wordless Apple-like mobile UI: the deployment URL is the room, the first phone is host, later phones join nearby.
- Browser sensor acquisition hook for mic level, sample rate, motion/orientation, and geolocation accuracy.
- Host-anchored clock sync: the first device's clock is the room reference. Peers NTP-sync against the host over WebRTC data channels (clock probes + acks carrying host-epoch instants), which keeps inter-device error in the low milliseconds on a shared network. HTTP echo to the server remains only as a fallback prior when no data channel is open.
- Per-audio-frame timestamp metadata: sample index, sample rate, audio context time, performance origin, host-estimated epoch, offset, jitter, best RTT, max error, and uncertainty.
- Edge reconciliation: chirp schedules and pulse observations flow peer→host→peers over data channels; every device derives pairwise ranges locally from that shared evidence and merges them with the polled server ranges, so the constellation updates without waiting on server round trips. The calibration turn rotation is likewise derived client-side from the shared host clock.
- URL-based room claim: first device is host, later devices are nearby phones.
- Polling room heartbeat for active device presence, sensor status, clock quality, and audio-frame timing metadata.
- Storage readiness endpoint at `/api/session/readiness` so production can prove whether room state is durable Redis or degraded in-memory.
- Active acoustic pulse history: devices take deterministic host-clock turns publishing scheduled ultrasonic-ish pulses, phones observe latest and bounded historical pulse announcements, match self and peer chirps in rolling sample windows, and room state derives pairwise ranges from reciprocal same-device sample intervals rather than subtracting two device clocks.
- Minimal phone markers are now layout-driven from fresh acoustic ranges when present, centered on the current phone, heading-rotated when orientation is available, and visually parked as low-confidence peers before measurements arrive.
- Stale hosts are released so the next active device can become host instead of leaving the room pinned forever.
- Session APIs use a `SessionStore` abstraction: Upstash Redis via Vercel Marketplace env when configured, in-memory fallback when not.
- Tested acoustic delay primitives and distance conversion.
- Tested pairwise calibration planner with robust median/outlier handling.
- Tested 2D weighted stress minimization for relative phone layout.
- Provider seam for production realtime; app runs in demo mode without credentials.

## Research Direction

The core V1 assumption is active acoustic calibration, not passive GPS/gyro inference. Each phone now has enough live orchestration to play and record short chirps in deterministic turns, estimate sample offsets on-device, exchange derived ranges, reject outliers, and solve a 2D layout. See `docs/research/blackmagic-v1-technical-brief.md`.

Audio timing is treated as sample-domain truth. Browser/network clocks are synchronized continuously as a coarse host-time prior with explicit uncertainty, then audio events are mapped through a Web Audio context-time/performance-time anchor so historical samples are not collapsed to heartbeat delivery time. Every active mic heartbeat can now carry an audio-frame stamp and a rolling local audio window for on-device pulse detection; acoustic pulse observations preserve detected sample indices, while host timestamps are used for ordering and UI freshness rather than direct distance math. The room state keeps bounded pulse/observation histories so late heartbeats can still be reconciled by the original audio-event timestamp rather than by server receive time, but live ranges expire out of the constellation when the last reciprocal chirp evidence is stale. Localization should ultimately realign recordings by sample indices and audio cross-correlation.

## Commands

```bash
npm run dev
npm test
npm run lint
npm run build
```

Two-phone pairwise field proof:

```bash
npm run trial:live -- --min-devices 2
npm run trial:report -- artifacts/live-trials/<trial-slug>/trial-evidence.json
```

Three-or-more phone full-room proof:

```bash
npm run trial:live -- --min-devices 3
npm run trial:report -- artifacts/live-trials/<trial-slug>/trial-evidence.json
```

Production preview:

```bash
npm run build
npm run start
```

## Realtime And Presence

Vercel hosts the app, HTTPS sensor permission surface, URL session pages, and token APIs. Persistent realtime should live in a provider such as Ably, with WebRTC/TURN added for reliable media/data channels. Without `ABLY_API_KEY`, `/api/realtime/config` reports demo mode.

Room presence is server-polled today. In production, set `KV_REST_API_URL` and `KV_REST_API_TOKEN` from a Vercel Marketplace Redis integration to make host claims and sensor presence durable across serverless instances. Without those variables, the app keeps the local in-memory store for development and demo deployments.

Check `/api/session/readiness` on the deployment before serious multi-phone tests. `status: "ready"` means Redis is active; `status: "degraded"` means production is using process-local memory and room continuity can depend on serverless instance reuse.

Durable polling is still not the final realtime layer. The next step is pushing the same heartbeat/timing payloads over realtime pub/sub so phones see each other with lower latency.

Vercel Marketplace Redis install:

```bash
vercel integration add upstash/upstash-kv
```
