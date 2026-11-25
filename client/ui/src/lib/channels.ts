import { coreApi } from "@/core";
import type { ChannelView, CoreState } from "@/core/api";
import { asCoreError } from "@/lib/coreError";
import { useAppStore } from "@/store/appStore";
import { useCoreStore, runCoreAction } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

/** Channels sorted by position, name and id — the order the server intends. */
export function sortedChannels(channels: ChannelView[]): ChannelView[] {
  return channels
    .slice()
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.name.localeCompare(b.name) ||
        a.id - b.id,
    );
}

/**
 * Depth-first order used by the tree and the command palette: a parent comes
 * before its children, and a child never jumps above an earlier category.
 */
export function flattenChannels(
  channels: ChannelView[],
): { channel: ChannelView; depth: number }[] {
  const ordered = sortedChannels(channels);
  const ids = new Set(ordered.map((channel) => channel.id));
  const byParent = new Map<number, ChannelView[]>();
  for (const channel of ordered) {
    const parent =
      channel.parentId !== 0 && ids.has(channel.parentId) ? channel.parentId : 0;
    const list = byParent.get(parent) ?? [];
    list.push(channel);
    byParent.set(parent, list);
  }
  const result: { channel: ChannelView; depth: number }[] = [];
  const seen = new Set<number>();
  function walk(parentId: number, depth: number) {
    for (const channel of byParent.get(parentId) ?? []) {
      if (seen.has(channel.id)) {
        continue;
      }
      seen.add(channel.id);
      result.push({ channel, depth });
      walk(channel.id, depth + 1);
    }
  }
  walk(0, 0);
  return result;
}

/** First joinable voice channel, preferring the remembered one. */
export function defaultVoiceChannel(
  state: CoreState,
  preferred: number | null,
): ChannelView | undefined {
  const voice = sortedChannels(
    state.channels.filter((channel) => channel.kind === "voice"),
  );
  if (preferred !== null) {
    const found = voice.find((channel) => channel.id === preferred);
    if (found) {
      return found;
    }
  }
  return voice.find(
    (channel) =>
      channel.userLimit === 0 || channel.userCount < channel.userLimit,
  );
}

/**
 * Joins a voice channel and remembers it as the default. The server decides
 * whether the join is allowed; the UI never pre-checks permissions
 * (stage 2.4 requirement 10).
 *
 * A click on the channel the user already sits in is a no-op only while the
 * media engine really holds that room: the server removes and re-adds the
 * participant, which tears the media session down for ~100 ms, so repeated
 * clicks looked like dropped voice (stage 2.3.4, live run 2.3). When the
 * presence is there but the media is gone — a moderator moved the user, the
 * rights changed and the server evicted them, or a renewal failed — the click
 * must restore audio. The core turns such a join into a media credential
 * request, so the server does not have to move the participant again.
 */
export async function joinVoiceChannel(channelId: number): Promise<boolean> {
  if (currentVoiceChannelId() === channelId && hasLiveVoiceMedia(channelId)) {
    const settings = useSettingsStore.getState().settings;
    if (settings && settings.defaultChannelId !== channelId) {
      await useSettingsStore.getState().update({ defaultChannelId: channelId });
    }
    return true;
  }
  try {
    await coreApi.joinChannel(channelId, null);
    const settings = useSettingsStore.getState().settings;
    if (settings && settings.defaultChannelId !== channelId) {
      await useSettingsStore.getState().update({ defaultChannelId: channelId });
    }
    return true;
  } catch (error) {
    const coreError = asCoreError(error);
    if (coreError.serverCode === "channelPasswordRequired") {
      // The server decides that a password is needed; ask for it and retry
      // with the same channel instead of leaving the user with a dead end.
      useAppStore.getState().openChannelPassword(channelId);
      return false;
    }
    const channel = useCoreStore
      .getState()
      .state?.channels.find((item) => item.id === channelId);
    useCoreStore
      .getState()
      .setActionError(coreError, channel?.name ?? null);
    return false;
  }
}

/**
 * Channel of the own user, or `null` when the user is not in a voice channel.
 *
 * The control-plane mirror is the primary source. When it has no self user at
 * all (before the first snapshot, or a reset) the engine still knows the room
 * it is connected to, so a click during that window is not turned into a
 * redundant join.
 */
export function currentVoiceChannelId(): number | null {
  const self = selfUser(useCoreStore.getState().state);
  if (self) {
    // The mirror is authoritative once it has the own user, including "not in
    // a channel" after a leave: the engine may still hold the old room id for
    // a moment, and that must not turn a real join into a no-op.
    return self.channelId > 0 ? self.channelId : null;
  }
  const engineChannel = useVoiceStore.getState().state?.channelId ?? 0;
  return engineChannel > 0 ? engineChannel : null;
}

/**
 * True when the voice engine has a live (or opening) room in this channel.
 *
 * The control mirror says where the user should be; the engine says whether
 * audible media is actually there. A moderator move updates the mirror but
 * removes the media participant, so the two disagree until audio is restored.
 */
export function hasLiveVoiceMedia(channelId: number): boolean {
  const engine = useVoiceStore.getState().state;
  if (!engine || engine.channelId !== channelId) {
    return false;
  }
  return (
    engine.media === "connecting" ||
    engine.media === "connected" ||
    engine.media === "reconnecting"
  );
}

/** Leaves the current voice channel. */
export async function leaveVoiceChannel(): Promise<void> {
  await runCoreAction(() => coreApi.leaveChannel());
}

/** Own user from the mirrored snapshot. */
export function selfUser(state: CoreState | null) {
  return state?.users.find((user) => user.id === state.selfUserId);
}

/** True when the user is in this channel. */
export function isInChannel(state: CoreState | null, channelId: number): boolean {
  return selfUser(state)?.channelId === channelId;
}

/** Updates the shared mirror after a command that returns a snapshot. */
export function applySnapshot(state: CoreState): void {
  useCoreStore.getState().snapshot(state);
}
