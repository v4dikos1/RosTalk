import type { ChatTarget, MessageView } from "@/core/api";

/**
 * Chat fixture for the component gallery and Playwright screenshots.
 *
 * The fixture adapter has no server, so `lib/chat.ts` short-circuits history
 * and uploads when the proxy URL starts with `fixture://`. This file is never
 * read by the desktop application.
 */

const minute = 60_000;
const chatStart = Date.UTC(2026, 10, 21, 18, 0);

/** Inline SVG is used only for gallery images, never as a real attachment. */
const fixtureImage = (from: string, to: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="480" height="300" fill="url(#g)"/><circle cx="360" cy="90" r="52" fill="rgba(255,255,255,0.35)"/><path d="M0 240 L120 160 L220 220 L340 120 L480 210 L480 300 L0 300 Z" fill="rgba(0,0,0,0.25)"/></svg>`,
  )}`;

export const fixtureMessages: MessageView[] = [
  {
    id: 1,
    channelId: 1,
    senderId: 2,
    recipientId: 0,
    senderNickname: "Anya",
    body: "Привет! Правила короткие: **уважайте друг друга**, спам — в `#флуд`.",
    createdAtUnixMs: chatStart,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
  },
  {
    id: 2,
    channelId: 1,
    senderId: 1,
    recipientId: 0,
    senderNickname: "Alex",
    body: "Добавил ссылку https://status.example.com в закреп — там статус и история падений.",
    createdAtUnixMs: chatStart + minute,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
  },
  {
    id: 3,
    channelId: 1,
    senderId: 3,
    recipientId: 0,
    senderNickname: "Maxim",
    body: "@Alex посмотри, как теперь выглядит лента: картинки открываются по клику.",
    createdAtUnixMs: chatStart + 2 * minute,
    editedAtUnixMs: 0,
    attachments: [
      {
        id: 101,
        fileName: "screenshot.png",
        contentType: "image/png",
        sizeBytes: 184_320,
        width: 480,
        height: 300,
        image: true,
      },
    ],
    mentionUserIds: [1],
  },
  {
    id: 4,
    channelId: 1,
    senderId: 2,
    recipientId: 0,
    senderNickname: "Anya",
    body: "Код для сборки:\n```\nmake check && make build-client\n```",
    createdAtUnixMs: chatStart + 3 * minute,
    editedAtUnixMs: chatStart + 4 * minute,
    attachments: [],
    mentionUserIds: [],
  },
  {
    id: 41,
    channelId: 1,
    senderId: 2,
    recipientId: 0,
    senderNickname: "Anya",
    body: "Проверила на своей машине — работает.",
    createdAtUnixMs: chatStart + 3.5 * minute,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
  },
  {
    id: 5,
    channelId: 0,
    senderId: 2,
    recipientId: 1,
    senderNickname: "Anya",
    body: "Скинешь вечером конфиг?",
    createdAtUnixMs: chatStart + 5 * minute,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
  },
  {
    id: 6,
    channelId: 0,
    senderId: 1,
    recipientId: 2,
    senderNickname: "Alex",
    body: "Да, после проверки релиза.",
    createdAtUnixMs: chatStart + 6 * minute,
    editedAtUnixMs: 0,
    attachments: [],
    mentionUserIds: [],
  },
];

const fixtureAttachmentUrls = new Map<number, string>([
  [101, fixtureImage("#f0a04b", "#c0587e")],
  [102, fixtureImage("#8ab4f8", "#4c7dd8")],
]);

export function fixtureAttachmentUrl(id: number): string {
  return fixtureAttachmentUrls.get(id) ?? fixtureImage("#3b4252", "#1f2430");
}

/** Chat history for the fixture adapter: no network and no server. */
export function fixtureChatHistory(
  target: ChatTarget,
  cursor: string,
  limit: number,
): {
  messages: MessageView[];
  nextCursor: string;
  hasMore: boolean;
} {
  const all = fixtureMessages
    .filter((message) =>
      target.kind === "channel"
        ? message.channelId === target.channelId
        : message.channelId === 0 &&
          (message.senderId === target.peerId ||
            message.recipientId === target.peerId),
    )
    .sort((a, b) => a.id - b.id);
  const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
  const older = all.filter((message) => message.id < before);
  const page = older.slice(Math.max(0, older.length - limit));
  const first = page[0];
  return {
    messages: page,
    nextCursor: older.length > page.length && first ? String(first.id) : "",
    hasMore: older.length > page.length,
  };
}

/** Simulates an upload with progress for the gallery. */
export function fixtureUpload(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<number> {
  return new Promise((resolve) => {
    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      onProgress?.(Math.min(1, step / 4));
      if (step >= 4) {
        window.clearInterval(timer);
        resolve(100 + Math.floor(Math.random() * 1000));
      }
    }, 40);
    void file;
  });
}
