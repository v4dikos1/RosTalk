import { coreApi } from "@/core";
import type { CoreEvent, SoundEvent, UserView } from "@/core/api";
import { useCoreStore } from "@/store/coreStore";
import { useVoiceStore } from "@/store/voiceStore";

/**
 * Presence-driven event cues that the core cannot see on its own (stage P10).
 *
 * The core already sounds channel joins/leaves, microphone, deafen, connection
 * and push-to-talk. Screen shares, their audiences and direct messages are
 * known to the UI (the stream engine and the chat mirror), so this module turns
 * presence deltas into the stream cues and asks the core to play them. Playback
 * and the saved switches stay in the voice engine.
 *
 * The first snapshot never beeps: users that were already streaming when the
 * client started are only recorded, not announced.
 */

/** How often the streamer hears "someone started watching" at most (P12). */
export const VIEWER_CUE_MIN_INTERVAL_MS = 5_000;

/** Presence fields that decide a cue. */
export interface StreamPresence {
  channelId: number;
  streaming: boolean;
  /** Streamer ids this user watches (stage P12). */
  watching: number[];
}

/** Presence of everyone in the server, keyed by user id. */
export type StreamPresenceMap = ReadonlyMap<number, StreamPresence>;

/**
 * Compares two presence maps and returns the cues to play.
 *
 * Only users in the user's own voice channel count, and only a fresh start or
 * stop produces a cue. A participant leaving the channel is not a stream end:
 * `userMoved` clears the flag and the channel itself announces the leave.
 */
export function streamCues(
  previous: StreamPresenceMap,
  next: StreamPresenceMap,
  selfId: number,
  myChannelId: number,
): SoundEvent[] {
  if (myChannelId <= 0) {
    return [];
  }
  const cues: SoundEvent[] = [];
  for (const [userId, presence] of next) {
    if (presence.channelId !== myChannelId) {
      continue;
    }
    const before = previous.get(userId);
    const wasStreaming = before?.streaming === true && before.channelId === myChannelId;
    if (presence.streaming && !wasStreaming) {
      cues.push(userId === selfId ? "selfStreamStarted" : "streamStarted");
    } else if (!presence.streaming && wasStreaming) {
      // There is no separate "someone else stopped" cue in the set: only the
      // own stream end is worth a sound.
      if (userId === selfId) {
        cues.push("selfStreamEnded");
      }
    }
  }
  // The own row can disappear entirely when the session ends; another user's
  // row disappearing is a leave, not a stream end.
  const own = previous.get(selfId);
  if (
    own?.streaming === true &&
    own.channelId === myChannelId &&
    !next.has(selfId)
  ) {
    cues.push("selfStreamEnded");
  }
  return cues;
}

/** Everyone who watches the own stream (stage P12). */
export function selfStreamViewers(
  presence: StreamPresenceMap,
  selfId: number,
): Set<number> {
  const viewers = new Set<number>();
  if (selfId <= 0) {
    return viewers;
  }
  for (const [userId, item] of presence) {
    if (userId !== selfId && item.watching.includes(selfId)) {
      viewers.add(userId);
    }
  }
  return viewers;
}

/**
 * Decides whether a growing audience deserves the "someone started watching"
 * cue.
 *
 * The cue only fires when the audience grew, and never more often than
 * `VIEWER_CUE_MIN_INTERVAL_MS`: a group of friends opening the stream together
 * is one sound, not five. A suppressed cue is not replayed later.
 */
export function viewerCueDue(
  previous: ReadonlySet<number>,
  next: ReadonlySet<number>,
  lastPlayedAt: number,
  now: number,
): boolean {
  if (next.size <= previous.size) {
    return false;
  }
  return now - lastPlayedAt >= VIEWER_CUE_MIN_INTERVAL_MS;
}

/** Builds the presence map from a full snapshot. */
function presenceOf(users: UserView[]): Map<number, StreamPresence> {
  return new Map(
    users.map((user) => [
      user.id,
      {
        channelId: user.channelId,
        streaming: user.streaming,
        watching: [...user.watchingUserIds],
      },
    ]),
  );
}

/**
 * Starts the mirror: presence deltas in, core cues out.
 * Returns the unsubscribe function. Call once from the root component.
 */
export function startSoundMirror(): () => void {
  let presence: Map<number, StreamPresence> = new Map();
  let viewers: Set<number> = new Set();
  let lastViewerCueAt = 0;
  let selfId = 0;

  const play = (cue: SoundEvent) => {
    void coreApi.playVoiceSound(cue).catch(() => {});
  };

  const apply = (next: Map<number, StreamPresence>, channelId: number) => {
    for (const cue of streamCues(presence, next, selfId, channelId)) {
      play(cue);
    }
    const nextViewers = selfStreamViewers(next, selfId);
    const now = Date.now();
    if (viewerCueDue(viewers, nextViewers, lastViewerCueAt, now)) {
      lastViewerCueAt = now;
      notifyStreamViewerJoined();
    }
    viewers = nextViewers;
    presence = next;
  };

  const unsubscribe = coreApi.subscribe((event: CoreEvent) => {
    if (event.type === "snapshot") {
      selfId = event.payload.selfUserId;
      presence = presenceOf(event.payload.users);
      viewers = selfStreamViewers(presence, selfId);
      return;
    }
    const delta = event.payload;
    const channelId = useVoiceStore.getState().state?.channelId ?? 0;
    switch (delta.type) {
      case "userJoined":
      case "userUpdated": {
        const next = new Map(presence);
        next.set(delta.payload.id, {
          channelId: delta.payload.channelId,
          streaming: delta.payload.streaming,
          watching: [...delta.payload.watchingUserIds],
        });
        apply(next, channelId);
        break;
      }
      case "userMoved": {
        const next = new Map(presence);
        // The server clears the streaming flag and the viewer list when the
        // user leaves a channel.
        next.set(delta.payload.userId, {
          channelId: delta.payload.toChannelId,
          streaming: false,
          watching: [],
        });
        apply(next, channelId);
        break;
      }
      case "userLeft": {
        const next = new Map(presence);
        next.delete(delta.payload.userId);
        apply(next, channelId);
        break;
      }
      case "reset": {
        presence = new Map();
        viewers = new Set();
        lastViewerCueAt = 0;
        selfId = 0;
        break;
      }
      case "connection": {
        selfId = useCoreStore.getState().state?.selfUserId ?? selfId;
        break;
      }
      default:
        break;
    }
  });
  return unsubscribe;
}

/**
 * Cue for "someone started watching my stream" (stage P12).
 *
 * Called by the sound mirror when the audience of the own stream grows; the
 * anti-spam interval lives there, so the cue itself stays a single request to
 * the core.
 */
export function notifyStreamViewerJoined(): void {
  void coreApi.playVoiceSound("streamViewerJoined").catch(() => {});
}
