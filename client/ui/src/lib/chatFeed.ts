import type { ChatTarget, LocalePreference, MessageView } from "@/core/api";
import { dayKey, dayLabelFor, type DayLabel } from "@/lib/time";

/** One row of the virtualized feed: a separator or a message. */
export type FeedRow =
  | { key: string; kind: "date"; label: DayLabel }
  | { key: string; kind: "new" }
  | { key: string; kind: "message"; message: MessageView; continued: boolean };

/** Two messages of one author closer than this belong to the same group. */
export const CHAT_GROUP_WINDOW_MS = 5 * 60 * 1000;

/** The unread counters as the feed sees them. */
export interface ReadCounter {
  channelId: number;
  peerUserId: number;
  unread: number;
  lastReadMessageId: number;
  lastMessageId: number;
}

/**
 * Read marker of one conversation at the moment the feed opens.
 *
 * The anchor is taken once per open and never follows the live counter: the
 * feed advances the marker as soon as it shows the newest message, and a
 * moving anchor made the "new messages" line jump on every message. `0` means
 * "nothing was unread when the conversation opened", so no separator is drawn:
 * messages that arrive while the reader sits at the bottom are not unread.
 */
export function readAnchor(
  counters: readonly ReadCounter[] | undefined,
  target: ChatTarget,
): number {
  if (!counters) {
    return 0;
  }
  const match =
    target.kind === "channel"
      ? counters.find(
          (counter) =>
            counter.channelId === target.channelId && counter.peerUserId === 0,
        )
      : counters.find(
          (counter) =>
            counter.channelId === 0 && counter.peerUserId === target.peerId,
        );
  if (!match) {
    return 0;
  }
  const hasUnread =
    match.unread > 0 || match.lastReadMessageId < match.lastMessageId;
  return hasUnread ? match.lastReadMessageId : 0;
}

/**
 * Inserts day separators and the "new messages" line as real rows.
 *
 * They go through the virtualizer like messages, so heights stay measured and
 * the scroll position does not jump when a boundary scrolls into view.
 *
 * A message continues the previous group when the row directly above is a
 * message of the same author, less than five minutes apart, with no separator
 * in between. The item then drops its avatar and name line (stage P9).
 */
export function buildFeedRows(
  messages: MessageView[],
  lastReadMessageId: number,
  locale: LocalePreference,
): FeedRow[] {
  const rows: FeedRow[] = [];
  let currentDay: string | null = null;
  let markerPlaced = false;
  let previous: MessageView | null = null;
  for (const message of messages) {
    const day = dayKey(message.createdAtUnixMs);
    if (day !== currentDay) {
      currentDay = day;
      previous = null;
      rows.push({
        key: `date:${day}`,
        kind: "date",
        label: dayLabelFor(message.createdAtUnixMs, locale),
      });
    }
    if (
      !markerPlaced &&
      lastReadMessageId > 0 &&
      message.id > lastReadMessageId
    ) {
      markerPlaced = true;
      previous = null;
      rows.push({ key: `new:${lastReadMessageId}`, kind: "new" });
    }
    const gap = previous ? message.createdAtUnixMs - previous.createdAtUnixMs : -1;
    const continued =
      previous !== null &&
      previous.senderId === message.senderId &&
      gap >= 0 &&
      gap < CHAT_GROUP_WINDOW_MS;
    rows.push({
      key: `message:${message.id}`,
      kind: "message",
      message,
      continued,
    });
    previous = message;
  }
  return rows;
}
