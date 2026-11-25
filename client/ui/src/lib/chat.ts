import type {
  ChatProxyView,
  ChatTarget,
  MessageView,
} from "@/core/api";
import {
  fixtureAttachmentUrl,
  fixtureChatHistory,
  fixtureUpload,
} from "@/mock/chatFixtures";

/**
 * Client side of the chat HTTP proxy (stage 4.1).
 *
 * Every call goes to the core's loopback proxy (`http://127.0.0.1:<port>`) with
 * the per-process token. The page never opens a TLS connection to the server
 * and never sees the server session token, so the pinned self-signed
 * certificate stays a core concern (design 4.3, ADR 0022).
 */

/**
 * Fallback only, for a snapshot that arrived before the server sent its limit
 * (or a fixture). The real value is `server.maxAttachmentBytes`; the server
 * enforces it again.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type ConversationKey = `channel:${number}` | `dm:${number}`;

export function conversationKey(target: ChatTarget): ConversationKey {
  return target.kind === "channel"
    ? `channel:${target.channelId}`
    : `dm:${target.peerId}`;
}

export function targetFromKey(key: ConversationKey): ChatTarget {
  const [kind, raw] = key.split(":");
  const id = Number(raw);
  return kind === "dm" ? { kind: "dm", peerId: id } : { kind: "channel", channelId: id };
}

/**
 * Conversation a message belongs to from one viewer's point of view. For a
 * direct message the peer is the recipient of an own message and the sender of
 * an incoming one.
 */
export function messageConversationKey(
  message: Pick<MessageView, "channelId" | "senderId" | "recipientId">,
  selfUserId: number,
): ConversationKey {
  if (message.channelId !== 0) {
    return `channel:${message.channelId}`;
  }
  const peer = message.senderId === selfUserId ? message.recipientId : message.senderId;
  return `dm:${peer}`;
}

/** Same as above for a deletion delta. */
export function deletedConversationKey(
  delta: { channelId: number; senderId: number; recipientId: number },
  selfUserId: number,
): ConversationKey {
  return messageConversationKey(
    {
      channelId: delta.channelId,
      senderId: delta.senderId,
      recipientId: delta.recipientId,
    },
    selfUserId,
  );
}

function isFixture(proxy: ChatProxyView): boolean {
  return proxy.baseUrl.startsWith("fixture://");
}

function headers(proxy: ChatProxyView): HeadersInit {
  return {
    "X-RosTalk-Proxy-Token": proxy.token,
    "Content-Type": "application/json",
  };
}

/** Base URL of one attachment, with the proxy token as a query parameter. */
export function attachmentUrl(proxy: ChatProxyView, attachmentId: number): string {
  if (isFixture(proxy)) {
    return fixtureAttachmentUrl(attachmentId);
  }
  const token = encodeURIComponent(proxy.token);
  return `${proxy.baseUrl}/chat/attachments/${attachmentId}?pt=${token}`;
}

export interface HistoryPage {
  messages: MessageView[];
  nextCursor: string;
  hasMore: boolean;
}

/** One page of history through the loopback proxy. */
export async function fetchHistory(
  proxy: ChatProxyView,
  target: ChatTarget,
  cursor: string,
  limit = 50,
): Promise<HistoryPage> {
  if (isFixture(proxy)) {
    return fixtureChatHistory(target, cursor, limit);
  }
  const params = new URLSearchParams();
  if (target.kind === "channel") {
    params.set("channelId", String(target.channelId));
  } else {
    params.set("peerId", String(target.peerId));
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  params.set("limit", String(limit));
  const response = await fetch(`${proxy.baseUrl}/chat/history?${params.toString()}`, {
    headers: headers(proxy),
  });
  if (!response.ok) {
    throw await proxyError(response);
  }
  return (await response.json()) as HistoryPage;
}

export interface UploadOptions {
  /** Called with 0…1 while the browser feeds bytes to the proxy. */
  onProgress?: (fraction: number) => void;
  /** Aborts the request when the user removes the file from the queue. */
  signal?: AbortSignal;
}

/**
 * Uploads one file and returns its attachment id. XMLHttpRequest is used
 * instead of fetch only because it reports upload progress.
 *
 * There is deliberately no whole-file timeout: a large video on a slow link is
 * fine as long as bytes keep moving. The core's proxy applies an idle timeout
 * and returns the `timeout` code when the connection really stalls.
 */
export function uploadAttachment(
  proxy: ChatProxyView,
  target: ChatTarget,
  file: File,
  options: UploadOptions = {},
): Promise<number> {
  const { onProgress, signal } = options;
  if (isFixture(proxy)) {
    return fixtureUpload(file, onProgress);
  }
  if (signal?.aborted) {
    return Promise.reject(new ChatHttpError(0, "aborted", "upload cancelled"));
  }
  const params = new URLSearchParams();
  if (target.kind === "channel") {
    params.set("channelId", String(target.channelId));
  } else {
    params.set("peerId", String(target.peerId));
  }
  params.set("name", file.name || "file");
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const settle = () => signal?.removeEventListener("abort", abort);
    request.open("POST", `${proxy.baseUrl}/chat/attachments?${params.toString()}`);
    request.setRequestHeader("X-RosTalk-Proxy-Token", proxy.token);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.total > 0 ? event.loaded / event.total : 0);
      }
    };
    request.onerror = () => {
      settle();
      reject(new ChatHttpError(0, "network", "upload failed"));
    };
    request.ontimeout = () => {
      settle();
      reject(new ChatHttpError(0, "timeout", "upload timed out"));
    };
    request.onabort = () => {
      settle();
      reject(new ChatHttpError(0, "aborted", "upload cancelled"));
    };
    request.onload = () => {
      settle();
      if (request.status >= 200 && request.status < 300) {
        try {
          const body = JSON.parse(request.responseText) as {
            attachment?: { id?: number };
          };
          if (typeof body.attachment?.id === "number") {
            resolve(body.attachment.id);
            return;
          }
        } catch {
          // Fall through to a readable error.
        }
        reject(new ChatHttpError(request.status, "invalid_response", "invalid upload reply"));
        return;
      }
      let code = "upload_failed";
      try {
        const body = JSON.parse(request.responseText) as {
          error?: { code?: string };
        };
        code = body.error?.code ?? code;
      } catch {
        // The status code is still enough for the UI mapping.
      }
      reject(new ChatHttpError(request.status, code, "upload failed"));
    };
    request.send(file);
  });
}

/** Error returned by a chat HTTP endpoint. Never contains a token. */
export class ChatHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ChatHttpError";
    this.status = status;
    this.code = code;
  }
}

async function proxyError(response: Response): Promise<ChatHttpError> {
  let code = "request_failed";
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    code = body.error?.code ?? code;
  } catch {
    // Keep the generic code.
  }
  return new ChatHttpError(response.status, code, "chat request failed");
}

/** Human size for attachment chips and image captions. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
