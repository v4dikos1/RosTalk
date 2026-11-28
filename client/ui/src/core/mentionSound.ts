import mentionSoundUrl from "@/assets/sounds/mention.wav";

/**
 * Mention chime (P33).
 *
 * A singleton `Audio` over the embedded asset: the first mention creates it,
 * every later one resets `currentTime` and replays. Autoplay refusals and a
 * missing `Audio` (tests, an embedded webview without media) are swallowed —
 * a mention must never break the message flow.
 *
 * Bursts are rate-limited to roughly one chime per second, so a page of tags
 * does not turn into a siren.
 */
const MIN_INTERVAL_MS = 1000;
const DEFAULT_VOLUME_PERCENT = 100;

let audio: HTMLAudioElement | null = null;
let lastPlayedAt = Number.NEGATIVE_INFINITY;

/** The cue setting is a percentage; the media element takes 0..1. */
function mediaVolume(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 1;
  }
  return Math.min(1, Math.max(0, percent / 100));
}

/**
 * Plays the chime; returns false when it was rate-limited or unavailable.
 *
 * `volumePercent` comes from the saved cue settings (0..100 %) and is applied
 * to the singleton element on every play, so a changed slider is heard on the
 * next mention without recreating the audio.
 */
export function playMentionSound(
  now = Date.now(),
  volumePercent = DEFAULT_VOLUME_PERCENT,
): boolean {
  if (typeof Audio === "undefined") {
    return false;
  }
  if (now - lastPlayedAt < MIN_INTERVAL_MS) {
    return false;
  }
  lastPlayedAt = now;
  try {
    audio ??= new Audio(mentionSoundUrl);
    audio.volume = mediaVolume(volumePercent);
    audio.currentTime = 0;
    const played = audio.play();
    if (played && typeof played.catch === "function") {
      played.catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/** Restores the singleton between tests. */
export function resetMentionSoundForTests(): void {
  audio = null;
  lastPlayedAt = Number.NEGATIVE_INFINITY;
}
