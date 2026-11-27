import type {
  ChatProxyView,
  ChatTarget,
  MessageView,
  UserView,
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
 * Who the editor may offer for "@": the online users except the author, and in
 * a direct message only the peer. The server resolves the tag again.
 */
export function mentionCandidates(
  users: UserView[],
  target: ChatTarget,
  selfUserId: number,
): UserView[] {
  return users.filter(
    (user) =>
      user.id !== selfUserId &&
      (target.kind === "channel" || user.id === target.peerId),
  );
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

/**
 * Largest picture the copy action accepts (stage P28).
 *
 * A memory guard for the user-initiated copy, not the server's upload limit:
 * the server may allow 2 GiB, but such a file is not a reasonable clipboard
 * operation. The body is streamed and cancelled at this limit, so a lying
 * `Content-Length` cannot make the page allocate the whole response.
 */
export const MAX_COPY_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Largest bitmap decoded for the clipboard. A 25 MiB PNG can describe a
 * 60 000 × 60 000 canvas; the check happens on the decoded `ImageBitmap`
 * before a canvas of that size is allocated.
 */
export const MAX_COPY_IMAGE_PIXELS = 24_000_000;

/** The attachment is above the byte or pixel limit. */
export class CopyLimitError extends Error {
  constructor() {
    super("picture is too large to copy");
    this.name = "CopyLimitError";
  }
}

/** The bytes are not a picture the WebView can decode. */
export class CopyDecodeError extends Error {
  constructor() {
    super("picture could not be decoded");
    this.name = "CopyDecodeError";
  }
}

/** The WebView clipboard refused the write (permission, lock or no API). */
export class CopyClipboardError extends Error {
  constructor(message = "the clipboard is unavailable") {
    super(message);
    this.name = "CopyClipboardError";
  }
}

/**
 * Reads a response body up to `limit` bytes, stopping the transfer when the
 * limit is crossed. The declared length is checked before the first byte.
 */
export async function readLimitedBody(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers?.get("content-length") ?? "";
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) {
      await response.body?.cancel().catch(() => {});
      throw new CopyLimitError();
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new CopyLimitError();
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException("copy aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new CopyLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (signal?.aborted) {
    throw new DOMException("copy aborted", "AbortError");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetches one attachment and turns it into a PNG blob for the clipboard.
 *
 * The bytes go through the authorised loopback proxy with the header token
 * (the `<img>` uses `?pt=` because it cannot set headers). The server applies
 * the same attachment permissions either way (ADR 0022). Decoding is bounded
 * twice: the streamed body by `MAX_COPY_IMAGE_BYTES` and the decoded bitmap by
 * `MAX_COPY_IMAGE_PIXELS`. `ImageBitmap.close()` and a zero-sized canvas
 * release the decode resources as soon as the PNG blob exists.
 */
async function attachmentToPng(
  proxy: ChatProxyView,
  attachmentId: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const init: RequestInit = {};
  if (!isFixture(proxy)) {
    init.headers = headers(proxy);
  }
  if (signal) {
    init.signal = signal;
  }
  const response = await fetch(
    isFixture(proxy)
      ? fixtureAttachmentUrl(attachmentId)
      : `${proxy.baseUrl}/chat/attachments/${attachmentId}`,
    init,
  );
  if (!response.ok) {
    throw await proxyError(response);
  }
  const bytes = await readLimitedBody(response, MAX_COPY_IMAGE_BYTES, signal);
  if (bytes.byteLength === 0) {
    throw new CopyDecodeError();
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes.slice().buffer]));
  } catch {
    throw new CopyDecodeError();
  }
  const canvas = document.createElement("canvas");
  try {
    if (bitmap.width === 0 || bitmap.height === 0) {
      throw new CopyDecodeError();
    }
    if (bitmap.width * bitmap.height > MAX_COPY_IMAGE_PIXELS) {
      throw new CopyLimitError();
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new CopyDecodeError();
    }
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new CopyDecodeError());
        }
      }, "image/png");
    });
    if (signal?.aborted) {
      throw new DOMException("copy aborted", "AbortError");
    }
    return png;
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Copies one chat picture through the built-in WebView2 Clipboard API.
 *
 * The `ClipboardItem` receives a `Promise<Blob>` (Clipboard API spec), so
 * `navigator.clipboard.write` is called synchronously from the click handler
 * before the first `await`: transient activation is preserved while the
 * authorised proxy request and PNG conversion finish. No native clipboard
 * write is involved.
 */
export function copyPictureToClipboard(
  proxy: ChatProxyView,
  attachmentId: number,
  signal?: AbortSignal,
): Promise<void> {
  const png = attachmentToPng(proxy, attachmentId, signal);
  // Keep a rejected conversion from becoming an unhandled rejection when the
  // clipboard call fails before it observes the promise.
  void png.catch(() => {});
  try {
    return navigator.clipboard.write([
      new ClipboardItem({ "image/png": png }),
    ]);
  } catch (error) {
    throw new CopyClipboardError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Maps a failed picture copy to a localised `chat.*` key, or `null` when the
 * copy was abandoned because the session changed or the view closed.
 */
export function copyImageErrorKey(error: unknown): string | null {
  if (error instanceof ChatHttpError) {
    if (error.status === 404) {
      return "chat.copyImageGone";
    }
    if (error.status === 403) {
      return "chat.copyImageNoAccess";
    }
    return "chat.copyImageFailed";
  }
  if (error instanceof CopyLimitError) {
    return "chat.copyImageTooLarge";
  }
  if (error instanceof CopyDecodeError) {
    return "chat.copyImageBroken";
  }
  if (error instanceof CopyClipboardError) {
    return "chat.copyImageClipboardBusy";
  }
  if (error instanceof DOMException) {
    if (error.name === "AbortError") {
      return null;
    }
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "chat.copyImageClipboardBusy";
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return null;
  }
  return "chat.copyImageFailed";
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
