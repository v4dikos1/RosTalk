import type { ConnectionPhase, VoiceStats } from "@/core/api";

/**
 * Connection quality bucket shown by the indicator.
 *
 * In a voice channel the three gradations come from real `VoiceStats`
 * (ping, packet loss, jitter, playback gaps); outside a call the indicator
 * says "online" instead of pretending to measure a media path.
 */
export type ConnectionQuality =
  | "excellent"
  | "good"
  | "fair"
  | "online"
  | "offline";

/** Everything the indicator needs; all fields are mirrors, nothing is derived. */
export interface QualitySnapshot {
  /** Control-plane connection phase, `null` before the first snapshot. */
  connection: ConnectionPhase | null;
  /** Media channel id, 0 outside a voice channel. */
  voiceChannelId: number;
  /** Latest media statistics snapshot. */
  stats: VoiceStats | null;
  /** The snapshot before `stats`, for per-interval counter deltas. */
  previous: VoiceStats | null;
}

/** Below these values a voice session counts as excellent. */
const EXCELLENT = { loss: 1, jitter: 15, ping: 80 } as const;
/** At or above these values a voice session counts as unstable. */
const FAIR = { loss: 5, jitter: 40, ping: 200 } as const;
/** Playback gaps per one-second snapshot that turn the bucket to fair. */
const GAP_BUDGET = 2;

/**
 * Counter delta between two snapshots.
 *
 * The pipeline counters are monotonic while one audio tract runs, but they
 * restart at zero after a device change; a negative difference is a reset, not
 * a negative count.
 */
export function counterDelta(previous: number, current: number): number {
  return current >= previous ? current - previous : 0;
}

/**
 * Maps the connection phase and media statistics to one bucket.
 *
 * - no connection -> `offline`;
 * - connecting or reconnecting -> `fair`;
 * - connected but not in a voice channel -> `online`;
 * - in a voice channel -> `excellent` / `good` / `fair` by real metrics.
 *
 * `mixer_underruns` is deliberately not scored: a remote participant on voice
 * activation sends nothing between phrases, so its track starves the mixer by
 * design. Playback gaps and publish overflows are defects and do count.
 */
export function qualityFor({
  connection,
  voiceChannelId,
  stats,
  previous,
}: QualitySnapshot): ConnectionQuality {
  if (!connection || connection === "disconnected") {
    return "offline";
  }
  if (connection === "connecting" || connection === "reconnecting") {
    return "fair";
  }
  if (voiceChannelId === 0) {
    return "online";
  }
  if (!stats) {
    // Connected to the room but the first statistics snapshot has not arrived.
    return "good";
  }

  const loss = stats.packetLossPercent ?? 0;
  const jitter = stats.jitterMs ?? 0;
  const ping = stats.pingMs ?? 0;
  const gaps = previous
    ? counterDelta(previous.audio.playbackUnderruns, stats.audio.playbackUnderruns)
    : 0;
  const overflow = previous
    ? counterDelta(previous.audio.publishOverflows, stats.audio.publishOverflows)
    : 0;

  if (
    loss >= FAIR.loss ||
    jitter >= FAIR.jitter ||
    ping >= FAIR.ping ||
    gaps > GAP_BUDGET ||
    overflow > 0
  ) {
    return "fair";
  }
  if (
    loss < EXCELLENT.loss &&
    jitter < EXCELLENT.jitter &&
    ping < EXCELLENT.ping &&
    gaps === 0
  ) {
    return "excellent";
  }
  return "good";
}
