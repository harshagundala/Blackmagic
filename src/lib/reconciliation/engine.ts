// Host-side reconciliation engine: turns the room's voice events into
// inter-device distances, a relative 2D constellation, and a live talker
// position. The host feeds it every device's voice events (its own from the
// sensor suite, peers' over the data channel) plus motion-stability signals,
// and polls `snapshot()` about once a second.
//
// All the heavy lifting lives in pure modules: clustering in
// deriveReconciledAudioEvents, GCC-PHAT pair alignment in
// derivePairTdoaObservations, the extreme-TDOA distance estimator in
// pair-tdoa-history, layout in estimateConstellation, talker localization in
// locateAudioSource. The engine is the stateful glue with the hygiene rules:
// idempotent ingestion, motion resets, and per-device event retention.

import {
  deriveReconciledAudioEvents,
  type ReconciledAudioEvent,
  type VoiceActivityEvent,
} from "../session/audio-events";
import {
  estimateConstellation,
  type ConstellationLayout,
  type PhonePoint,
} from "../positioning/layout";
import { derivePairTdoaObservations } from "./tdoa-observations";
import {
  clearPairHistoriesForDevice,
  createPairTdoaHistory,
  derivePairRangeEstimate,
  pairKeyFor,
  recordPairTdoaObservation,
  removePairObservationsNear,
  type PairRangeEstimate,
  type PairTdoaHistory,
  type PairTdoaObservation,
} from "./pair-tdoa-history";
import { locateAudioSource, type SourceHint } from "./source-locator";

export type ReconciliationSnapshot = {
  ranges: PairRangeEstimate[];
  layout: ConstellationLayout | null;
  talker: SourceHint | null;
  deviceIds: string[];
  // Field diagnostics: voice events currently retained per device, and GCC
  // matches accumulated per pair — make "why is nothing showing" answerable
  // from the phone screen.
  heardEvents: Array<{ deviceId: string; events: number }>;
  pairProgress: Array<{ from: string; to: string; observations: number }>;
  updatedAtHostEpochMs: number;
};

export type ReconciliationEngineOptions = {
  anchorDeviceId?: string | null;
};

const MAX_EVENTS_PER_DEVICE = 12;
const EVENT_MAX_AGE_MS = 45_000;
const MAX_CLUSTERS = 10;
const MOTION_STABILITY_FLOOR = 0.35;
const MOTION_SPIKE_RADIUS_MS = 1_000;
const SUSTAINED_MOTION_MS = 600;
const MIN_BIAS_CONFIDENCE = 0.25;
const TALKER_MAX_AGE_MS = 15_000;
const OBSERVATION_CACHE_LIMIT = 64;

export class ReconciliationEngine {
  private anchorDeviceId: string | null;
  private voiceEvents = new Map<string, VoiceActivityEvent[]>();
  private histories = new Map<string, PairTdoaHistory>();
  private observationCache = new Map<string, PairTdoaObservation[]>();
  private motionEpisodeStart = new Map<string, number>();
  private motionResetAt = new Map<string, number>();
  private previousPoints: Record<string, PhonePoint> | null = null;

  constructor({ anchorDeviceId = null }: ReconciliationEngineOptions = {}) {
    this.anchorDeviceId = anchorDeviceId;
  }

  setAnchorDevice(deviceId: string | null) {
    this.anchorDeviceId = deviceId;
  }

  ingestVoiceEvent(deviceId: string, event: VoiceActivityEvent | null) {
    if (!deviceId || !event?.id || !Number.isFinite(event.detectedAtHostEpochMs)) {
      return;
    }
    const events = (this.voiceEvents.get(deviceId) ?? [])
      .filter((entry) => entry.id !== event.id)
      .concat(event)
      .sort((a, b) => a.detectedAtHostEpochMs - b.detectedAtHostEpochMs);
    this.voiceEvents.set(
      deviceId,
      events.slice(Math.max(0, events.length - MAX_EVENTS_PER_DEVICE)),
    );
  }

  // Motion-stability hygiene: a brief spike voids nearby observations (the
  // phone was vibrating while it heard the event); sustained movement means
  // the geometry changed, so every pair the device participates in starts
  // over. The reset timestamp also blocks re-ingesting pre-move observations
  // when old events re-cluster.
  noteMotion(
    deviceId: string,
    stability: number | null | undefined,
    atHostEpochMs: number,
  ) {
    if (
      !deviceId ||
      typeof stability !== "number" ||
      !Number.isFinite(stability) ||
      !Number.isFinite(atHostEpochMs)
    ) {
      return;
    }

    if (stability >= MOTION_STABILITY_FLOOR) {
      this.motionEpisodeStart.delete(deviceId);
      return;
    }

    this.markUnstable(deviceId, atHostEpochMs);
    const episodeStart = this.motionEpisodeStart.get(deviceId);
    if (episodeStart === undefined) {
      this.motionEpisodeStart.set(deviceId, atHostEpochMs);
    } else if (atHostEpochMs - episodeStart >= SUSTAINED_MOTION_MS) {
      clearPairHistoriesForDevice(this.histories, deviceId);
      this.motionResetAt.set(deviceId, atHostEpochMs);
    }
  }

  removeDevice(deviceId: string) {
    this.voiceEvents.delete(deviceId);
    this.motionEpisodeStart.delete(deviceId);
    this.motionResetAt.delete(deviceId);
    clearPairHistoriesForDevice(this.histories, deviceId);
    if (this.previousPoints) {
      delete this.previousPoints[deviceId];
    }
  }

  snapshot(nowHostEpochMs: number): ReconciliationSnapshot {
    this.pruneVoiceEvents(nowHostEpochMs);
    const deviceIds = [...this.voiceEvents.keys()].sort();
    const events = deriveReconciledAudioEvents(
      deviceIds.map((deviceId) => ({
        deviceId,
        voiceEvents: this.voiceEvents.get(deviceId) ?? [],
      })),
      { maxEvents: MAX_CLUSTERS },
    );

    for (const event of events) {
      for (const observation of this.observationsForEvent(event)) {
        if (this.isVoidedByMotion(observation)) {
          continue;
        }
        const history =
          this.histories.get(observation.pairKey) ?? createPairTdoaHistory();
        this.histories.set(
          observation.pairKey,
          recordPairTdoaObservation(history, observation),
        );
      }
    }

    const ranges: PairRangeEstimate[] = [];
    for (const history of this.histories.values()) {
      const estimate = derivePairRangeEstimate(history, nowHostEpochMs);
      if (estimate) {
        ranges.push(estimate);
      }
    }
    ranges.sort((a, b) =>
      `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`),
    );

    const layout = this.solveLayout(deviceIds, ranges);
    const talker = this.locateTalker(events, layout, ranges, nowHostEpochMs);

    const heardEvents = deviceIds.map((deviceId) => ({
      deviceId,
      events: this.voiceEvents.get(deviceId)?.length ?? 0,
    }));
    const pairProgress = [...this.histories.entries()]
      .map(([pairKey, history]) => {
        const [from, to] = pairKey.split("|");
        return { from, to, observations: history.observations.length };
      })
      .sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`));

    return {
      ranges,
      layout,
      talker,
      deviceIds,
      heardEvents,
      pairProgress,
      updatedAtHostEpochMs: nowHostEpochMs,
    };
  }

  private solveLayout(
    deviceIds: string[],
    ranges: PairRangeEstimate[],
  ): ConstellationLayout | null {
    if (deviceIds.length < 2 || ranges.length === 0) {
      return null;
    }
    const anchorId =
      this.anchorDeviceId && deviceIds.includes(this.anchorDeviceId)
        ? this.anchorDeviceId
        : deviceIds[0];
    const layout = estimateConstellation(
      deviceIds,
      ranges.map((range) => ({
        from: range.from,
        to: range.to,
        meters: range.meters,
        weight: Math.max(0.05, range.confidence),
      })),
      { anchorId, previousPoints: this.previousPoints },
    );
    this.previousPoints = layout.points;
    return layout;
  }

  private locateTalker(
    events: ReconciledAudioEvent[],
    layout: ConstellationLayout | null,
    ranges: PairRangeEstimate[],
    nowHostEpochMs: number,
  ): SourceHint | null {
    if (!layout || Object.keys(layout.points).length < 3) {
      return null;
    }
    const biasByPair = new Map(
      ranges
        .filter((range) => range.confidence >= MIN_BIAS_CONFIDENCE)
        .map((range) => [pairKeyFor(range.from, range.to), range.biasMs]),
    );
    if (biasByPair.size < 2) {
      return null;
    }

    const candidates = [...events]
      .sort((a, b) => b.centerHostEpochMs - a.centerHostEpochMs)
      .filter(
        (event) =>
          nowHostEpochMs - event.centerHostEpochMs <= TALKER_MAX_AGE_MS,
      );
    for (const event of candidates) {
      const observations = this.observationsForEvent(event);
      if (observations.length < 2) {
        continue;
      }
      const hint = locateAudioSource({
        points: layout.points,
        observations,
        biasMsForPair: (pairKey) => biasByPair.get(pairKey) ?? null,
      });
      if (hint) {
        return hint;
      }
    }
    return null;
  }

  private observationsForEvent(event: ReconciledAudioEvent) {
    const cacheKey = `${event.id}#${[...event.observedDeviceIds]
      .sort()
      .join(",")}`;
    const cached = this.observationCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const observations = derivePairTdoaObservations(event);
    this.observationCache.set(cacheKey, observations);
    while (this.observationCache.size > OBSERVATION_CACHE_LIMIT) {
      const oldest = this.observationCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.observationCache.delete(oldest);
    }
    return observations;
  }

  private isVoidedByMotion(observation: PairTdoaObservation) {
    for (const deviceId of [observation.from, observation.to]) {
      const resetAt = this.motionResetAt.get(deviceId);
      if (
        resetAt !== undefined &&
        observation.atHostEpochMs <= resetAt + MOTION_SPIKE_RADIUS_MS
      ) {
        return true;
      }
    }
    return false;
  }

  private markUnstable(deviceId: string, atHostEpochMs: number) {
    for (const [pairKey, history] of this.histories) {
      const [from, to] = pairKey.split("|");
      if (from !== deviceId && to !== deviceId) {
        continue;
      }
      this.histories.set(
        pairKey,
        removePairObservationsNear(
          history,
          atHostEpochMs,
          MOTION_SPIKE_RADIUS_MS,
        ),
      );
    }
  }

  private pruneVoiceEvents(nowHostEpochMs: number) {
    for (const [deviceId, events] of this.voiceEvents) {
      const fresh = events.filter(
        (event) =>
          nowHostEpochMs - event.detectedAtHostEpochMs <= EVENT_MAX_AGE_MS,
      );
      if (fresh.length === 0) {
        this.voiceEvents.delete(deviceId);
      } else if (fresh.length !== events.length) {
        this.voiceEvents.set(deviceId, fresh);
      }
    }
  }
}
