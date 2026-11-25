import { describe, expect, it } from "vitest";

import type { ChatTarget, MessageView } from "@/core/api";

import { buildFeedRows, readAnchor, type FeedRow } from "./chatFeed";

function message(
  id: number,
  createdAtUnixMs: number,
  senderId = 2,
): MessageView {
  return {
    id,
    channelId: 1,
    senderId,
    recipientId: 0,
    senderNickname: "Anya",
    body: `#${id}`,
    createdAtUnixMs,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
  };
}

describe("buildFeedRows", () => {
  it("keeps day boundaries and the unread marker in order", () => {
    const day = new Date(2026, 10, 20, 12, 0).getTime();
    const next = new Date(2026, 10, 21, 9, 0).getTime();
    const rows = buildFeedRows(
      [message(1, day), message(2, day + 1000), message(3, next)],
      2,
      "ru",
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "date",
      "message",
      "message",
      "date",
      "new",
      "message",
    ]);
    expect(rows[4]?.key).toBe("new:2");
  });

  it("does not mark anything when every message is read", () => {
    const now = Date.now();
    const rows = buildFeedRows([message(1, now), message(2, now)], 5, "ru");
    expect(rows.some((row) => row.kind === "new")).toBe(false);
  });

  it("groups consecutive messages of one author within five minutes", () => {
    const now = new Date(2026, 10, 20, 12, 0).getTime();
    const rows = buildFeedRows(
      [message(1, now), message(2, now + 60_000), message(3, now + 120_000)],
      0,
      "ru",
    );
    const messages = rows.filter(
      (row): row is Extract<FeedRow, { kind: "message" }> =>
        row.kind === "message",
    );
    expect(messages.map((row) => row.continued)).toEqual([false, true, true]);
  });

  it("starts a new group for another author, a long gap or a separator", () => {
    const now = new Date(2026, 10, 20, 12, 0).getTime();
    const sameAuthor = buildFeedRows(
      [message(1, now), message(2, now + 5 * 60 * 1000)],
      0,
      "ru",
    );
    expect(
      sameAuthor.filter((row) => row.kind === "message").map((row) => row.continued),
    ).toEqual([false, false]);

    const otherAuthor = buildFeedRows(
      [message(1, now), message(2, now + 1000, 3)],
      0,
      "ru",
    );
    expect(
      otherAuthor.filter((row) => row.kind === "message").map((row) => row.continued),
    ).toEqual([false, false]);

    const acrossUnread = buildFeedRows(
      [message(1, now), message(2, now + 1000)],
      1,
      "ru",
    );
    expect(
      acrossUnread.filter((row) => row.kind === "message").map((row) => row.continued),
    ).toEqual([false, false]);

    const tomorrow = new Date(2026, 10, 21, 0, 1).getTime();
    const acrossDay = buildFeedRows(
      [message(1, now), message(2, tomorrow)],
      0,
      "ru",
    );
    expect(
      acrossDay.filter((row) => row.kind === "message").map((row) => row.continued),
    ).toEqual([false, false]);
  });
});

describe("readAnchor", () => {
  const channel: ChatTarget = { kind: "channel", channelId: 1 };

  it("returns the read marker of a channel that had unread messages", () => {
    expect(
      readAnchor(
        [
          {
            channelId: 1,
            peerUserId: 0,
            unread: 3,
            lastReadMessageId: 7,
            lastMessageId: 10,
          },
        ],
        channel,
      ),
    ).toBe(7);
  });

  it("returns zero when nothing was unread at open", () => {
    expect(
      readAnchor(
        [
          {
            channelId: 1,
            peerUserId: 0,
            unread: 0,
            lastReadMessageId: 10,
            lastMessageId: 10,
          },
        ],
        channel,
      ),
    ).toBe(0);
    expect(readAnchor([], channel)).toBe(0);
    expect(readAnchor(undefined, channel)).toBe(0);
  });

  it("takes the direct conversation peer from the counter of that peer", () => {
    const target: ChatTarget = { kind: "dm", peerId: 4 };
    expect(
      readAnchor(
        [
          {
            channelId: 0,
            peerUserId: 3,
            unread: 1,
            lastReadMessageId: 2,
            lastMessageId: 3,
          },
          {
            channelId: 0,
            peerUserId: 4,
            unread: 2,
            lastReadMessageId: 8,
            lastMessageId: 9,
          },
        ],
        target,
      ),
    ).toBe(8);
  });
});
