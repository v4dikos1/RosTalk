import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatProxyView, ChatTarget } from "@/core/api";
import {
  ChatHttpError,
  DEFAULT_MAX_UPLOAD_BYTES,
  uploadAttachment,
} from "@/lib/chat";

/** One file the user is about to send. */
export interface PendingAttachment {
  localId: number;
  /** Server attachment id, `null` while uploading or after a failure. */
  id: number | null;
  name: string;
  size: number;
  image: boolean;
  progress: number;
  /** Local preview for an image that has not reached the server yet. */
  previewUrl: string | null;
  error: string | null;
}

export interface ChatUploads {
  pending: PendingAttachment[];
  uploading: boolean;
  readyIds: number[];
  addFiles: (files: File[]) => void;
  remove: (localId: number) => void;
  clear: () => void;
}

let nextLocalId = 1;

/**
 * Upload queue for one conversation. Files go to the core's loopback proxy;
 * only the resulting attachment ids are sent with the message. Progress is
 * reported per file, and a failed file stays visible with a readable error.
 */
export function useChatUploads(
  target: ChatTarget,
  canAttach: boolean,
  proxy: ChatProxyView | null,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): ChatUploads {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const alive = useRef(true);
  // The cleanup effect runs before React commits the new queue, so it reads the
  // previews through a ref instead of a stale closure.
  const pendingRef = useRef<PendingAttachment[]>([]);
  // One controller per upload, so removing an item really stops the transfer
  // instead of only hiding it from the queue.
  const controllers = useRef(new Map<number, AbortController>());
  const targetKey =
    target.kind === "channel" ? `channel:${target.channelId}` : `dm:${target.peerId}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // A preview URL lives as long as the queue entry it belongs to. Leaving the
  // conversation or closing the composer must free the blob instead of keeping
  // the whole file in memory until the window is closed.
  useEffect(() => {
    // The ref object itself is stable; its map is replaced only in this
    // cleanup, so reading it here is intentional.
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) {
        controller.abort();
      }
      active.clear();
      for (const item of pendingRef.current) {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      pendingRef.current = [];
    };
  }, [targetKey]);

  // A conversation switch starts with an empty queue: files chosen for the old
  // conversation are not attachments of the new one.
  const [queueKey, setQueueKey] = useState(targetKey);
  if (queueKey !== targetKey) {
    setQueueKey(targetKey);
    setPending([]);
  }

  const update = useCallback(
    (localId: number, patch: Partial<PendingAttachment>) => {
      setPending((current) =>
        current.map((item) =>
          item.localId === localId ? { ...item, ...patch } : item,
        ),
      );
    },
    [],
  );

  const remove = useCallback((localId: number) => {
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);
    setPending((current) =>
      current.filter((item) => {
        if (item.localId !== localId) {
          return true;
        }
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
        return false;
      }),
    );
  }, []);

  const clear = useCallback(() => {
    for (const controller of controllers.current.values()) {
      controller.abort();
    }
    controllers.current.clear();
    setPending((current) => {
      for (const item of current) {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      return [];
    });
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (!canAttach || !proxy || files.length === 0) {
        return;
      }
      for (const file of files.slice(0, 10)) {
        const localId = nextLocalId++;
        const image = file.type.startsWith("image/");
        const previewUrl = image ? URL.createObjectURL(file) : null;
        if (file.size > maxBytes) {
          setPending((current) => [
            ...current,
            {
              localId,
              id: null,
              name: file.name || "file",
              size: file.size,
              image,
              progress: 0,
              previewUrl,
              error: "tooLarge",
            },
          ]);
          continue;
        }
        setPending((current) => [
          ...current,
          {
            localId,
            id: null,
            name: file.name || "file",
            size: file.size,
            image,
            progress: 0,
            previewUrl,
            error: null,
          },
        ]);
        const controller = new AbortController();
        controllers.current.set(localId, controller);
        void uploadAttachment(proxy, target, file, {
          signal: controller.signal,
          onProgress: (fraction) => {
            if (alive.current) {
              update(localId, { progress: fraction });
            }
          },
        })
          .then((id) => {
            if (alive.current) {
              update(localId, { id, progress: 1 });
            }
          })
          .catch((error: unknown) => {
            if (error instanceof ChatHttpError && error.code === "aborted") {
              return;
            }
            if (alive.current) {
              update(localId, { error: uploadErrorKey(error), progress: 0 });
            }
          })
          .finally(() => {
            controllers.current.delete(localId);
          });
      }
    },
    [canAttach, proxy, target, update, maxBytes],
  );

  const readyIds = pending
    .filter((item) => item.id !== null && item.error === null)
    .map((item) => item.id as number);

  return {
    pending,
    uploading: pending.some((item) => item.id === null && item.error === null),
    readyIds,
    addFiles,
    remove,
    clear,
  };
}

/**
 * Maps a failed upload to an i18n key. The proxy and the server send stable
 * codes; the status is only a fallback for an older server or a truncated
 * reply. A raw XHR network failure has status 0 and is reported by code.
 */
function uploadErrorKey(error: unknown): string {
  if (error instanceof ChatHttpError) {
    switch (error.code) {
      case "file_too_large":
        return "tooLarge";
      case "unsupported_type":
        return "unsupported";
      case "quota_exceeded":
        return "quota";
      case "timeout":
        return "timeout";
      case "network":
        return "network";
      case "rate_limited":
        return "rateLimited";
      case "permission_denied":
        return "forbidden";
      default:
        break;
    }
    if (error.status === 413) {
      return "tooLarge";
    }
    if (error.status === 415) {
      return "unsupported";
    }
    if (error.status === 507) {
      return "quota";
    }
    if (error.status === 429) {
      return "rateLimited";
    }
    if (error.status === 408 || error.status === 504) {
      return "timeout";
    }
    if (error.status === 401 || error.status === 403) {
      return "forbidden";
    }
    if (error.status === 0) {
      return "network";
    }
  }
  return "failed";
}
