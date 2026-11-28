import { Copy, Download, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { UserAvatar } from "@/components/common/UserAvatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  AttachmentView,
  ChatProxyView,
  MessageView,
  UserView,
} from "@/core/api";
import {
  attachmentUrl,
  copyImageErrorKey,
  copyPictureToClipboard,
  formatFileSize,
  MAX_COPY_IMAGE_BYTES,
  MAX_COPY_IMAGE_PIXELS,
} from "@/lib/chat";
import { Markup } from "@/lib/markup";
import { roleNameStyle } from "@/lib/roles";
import { formatClock } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

/** Stable empty list for a not-yet-hydrated core state. */
const NO_USERS: UserView[] = [];

export interface MessageItemProps {
  message: MessageView;
  selfUserId: number;
  /** Colour of the author when the user is online, for the avatar. */
  authorColor: string | null;
  /** Content hash of the author's picture, empty when none. */
  authorAvatarHash: string;
  /** Server identity: user ids are only unique per server. */
  serverId: string | null;
  proxy: ChatProxyView | null;
  canManage: boolean;
  /** The row above is this author's message within five minutes (stage P9). */
  continued?: boolean;
  onEdit: (messageId: number, body: string) => Promise<void>;
  onDelete: (messageId: number) => Promise<void>;
}

/**
 * One message row. The body goes through the safe markup renderer: message
 * text is never interpreted as HTML, and only http(s) links become anchors.
 */
export function MessageItem({
  message,
  selfUserId,
  authorColor,
  authorAvatarHash,
  serverId,
  proxy,
  canManage,
  continued = false,
  onEdit,
  onDelete,
}: MessageItemProps) {
  const { t } = useTranslation();
  const locale = useSettingsStore((store) => store.settings?.locale ?? "ru");
  const users = useCoreStore((store) => store.state?.users ?? NO_USERS);
  const author = users.find((user) => user.id === message.senderId) ?? null;
  // Only a nickname the server recorded as a mention of this message may link
  // to a user menu; an arbitrary "@word" in the body stays plain text.
  const mentionMap = useMemo(() => {
    const confirmed = new Set(message.mentionUserIds);
    const map = new Map<string, number>();
    for (const user of users) {
      if (confirmed.has(user.id)) {
        map.set(user.nickname.toLowerCase(), user.id);
      }
    }
    return map;
  }, [users, message.mentionUserIds]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  function revealActions() {
    toolbarRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();
  }
  const own = message.senderId === selfUserId;
  // manage_messages moderates and deletes; it never writes in another user's
  // name, so editing is the author's alone (ADR 0025).
  const editable = own;
  const deletable = own || canManage;
  const images = message.attachments.filter((attachment) => attachment.image);
  const videos = message.attachments.filter((attachment) =>
    attachment.contentType.startsWith("video/"),
  );
  const audios = message.attachments.filter((attachment) =>
    attachment.contentType.startsWith("audio/"),
  );
  const files = message.attachments.filter(
    (attachment) =>
      !attachment.image &&
      !attachment.contentType.startsWith("video/") &&
      !attachment.contentType.startsWith("audio/"),
  );

  async function save() {
    const body = draft.trim();
    if (!body || busy) {
      return;
    }
    setBusy(true);
    try {
      await onEdit(message.id, body);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onDelete(message.id);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      data-testid="message"
      data-message-id={message.id}
      tabIndex={-1}
      onContextMenu={(event) => {
        if (editable || deletable) {
          event.preventDefault();
          revealActions();
        }
      }}
      onKeyDown={(event) => {
        if (event.shiftKey && event.key === "F10" && (editable || deletable)) {
          event.preventDefault();
          revealActions();
        }
      }}
      className={cn(
        "group relative grid grid-cols-[56px_minmax(0,1fr)] px-4 py-0.5 hover:bg-hover/40 focus-visible:outline-none",
        !continued && "mt-2 pt-1",
        message.mentionUserIds.includes(selfUserId) &&
          "bg-accent/[0.07] shadow-[inset_2px_0_0_0_var(--accent)]",
      )}
    >
      <div className="flex justify-center pt-0.5">
        {continued ? (
          <time
            className="text-[11px] leading-5 text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
            dateTime={new Date(message.createdAtUnixMs).toISOString()}
          >
            {formatClock(message.createdAtUnixMs, locale)}
          </time>
        ) : (
          <UserAvatar
            name={message.senderNickname}
            color={authorColor}
            avatarHash={authorAvatarHash}
            serverId={serverId}
            userId={message.senderId}
            size="chat"
          />
        )}
      </div>
      <div className="min-w-0">
        {continued ? null : (
          <div className="flex items-baseline gap-2">
            {author ? (
              <button
                type="button"
                onClick={(event) =>
                  useAppStore
                    .getState()
                    .openUserMenu(
                      author.id,
                      event.clientX,
                      event.clientY,
                    )
                }
                aria-label={t("userMenu.title", {
                  name: message.senderNickname,
                })}
                data-testid="message-author"
                className="min-w-0 cursor-pointer truncate rounded-sm bg-transparent p-0 text-left text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                style={roleNameStyle(authorColor)}
              >
                {message.senderNickname}
              </button>
            ) : (
              <span
                className="min-w-0 truncate text-[13px] font-medium text-foreground"
                style={roleNameStyle(authorColor)}
                data-testid="message-author-offline"
              >
                {message.senderNickname}
              </span>
            )}
            <time
              className="shrink-0 text-[11px] text-faint"
              dateTime={new Date(message.createdAtUnixMs).toISOString()}
            >
              {formatClock(message.createdAtUnixMs, locale)}
            </time>
            {message.editedAtUnixMs > 0 ? (
              <span className="shrink-0 text-[11px] text-faint">
                {t("chat.edited")}
              </span>
            ) : null}
          </div>
        )}

        {editing ? (
          <div className="mt-1 space-y-1">
            <textarea
              value={draft}
              autoFocus
              rows={Math.min(6, Math.max(2, draft.split("\n").length))}
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setEditing(false);
                  setDraft(message.body);
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void save();
                }
              }}
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-accent"
              aria-label={t("chat.editLabel")}
              data-testid="message-edit-input"
            />
            <div className="flex items-center gap-1">
              <Button size="xs" disabled={busy || !draft.trim()} onClick={() => void save()}>
                {t("common.save")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setDraft(message.body);
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="whitespace-pre-wrap break-words text-[13px] leading-[1.45] text-foreground/90"
            data-testid="message-body"
          >
            <Markup
              text={message.body}
              mentions={mentionMap}
              onMentionClick={(userId, clientX, clientY) =>
                useAppStore
                  .getState()
                  .openUserMenu(userId, clientX, clientY)
              }
            />
          </div>
        )}

        {images.length > 0 && proxy ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {images.map((attachment) => (
              <ImageAttachment
                key={attachment.id}
                attachment={attachment}
                proxy={proxy}
              />
            ))}
          </div>
        ) : null}

        {videos.length > 0 && proxy ? (
          <div className="mt-1 flex flex-col gap-1.5">
            {videos.map((attachment) => (
              <video
                key={attachment.id}
                src={attachmentUrl(proxy, attachment.id)}
                controls
                preload="metadata"
                className="max-h-72 w-full max-w-[420px] rounded-lg border border-border bg-background"
                data-testid="attachment-video"
              />
            ))}
          </div>
        ) : null}

        {audios.length > 0 && proxy ? (
          <div className="mt-1 flex flex-col gap-1.5">
            {audios.map((attachment) => (
              <audio
                key={attachment.id}
                src={attachmentUrl(proxy, attachment.id)}
                controls
                preload="metadata"
                className="w-full max-w-[420px]"
                data-testid="attachment-audio"
              />
            ))}
          </div>
        ) : null}

        {files.length > 0 && proxy ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {files.map((attachment) => (
              <a
                key={attachment.id}
                href={attachmentUrl(proxy, attachment.id)}
                download={attachment.fileName}
                className="inline-flex max-w-72 items-center gap-1.5 rounded-lg border border-border bg-raised px-2 py-1 text-[11px] text-muted transition-colors duration-150 hover:border-accent/40 hover:text-foreground"
                data-testid="attachment-file"
              >
                <Download className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{attachment.fileName}</span>
                <span className="shrink-0 text-faint">
                  {formatFileSize(attachment.sizeBytes)}
                </span>
              </a>
            ))}
          </div>
        ) : null}
      </div>

      {editable || deletable ? (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={t("chat.messageActions")}
          className="pointer-events-none absolute -top-3.5 right-3 flex items-center gap-0.5 rounded-md border border-border bg-raised px-0.5 py-0.5 opacity-0 shadow-panel transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
        >
          {editable && message.body ? (
            <Button
              size="icon-sm" className="size-6"
              variant="ghost"
              aria-label={t("chat.edit")}
              title={t("chat.edit")}
              onClick={() => {
                setDraft(message.body);
                setEditing(true);
              }}
              data-testid="message-edit"
            >
              <Pencil className="size-3" aria-hidden />
            </Button>
          ) : null}
          {deletable ? (
            confirming ? (
              <span className="flex items-center gap-0.5">
                <Button
                  size="xs"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void remove()}
                  data-testid="message-delete-confirm"
                >
                  {t("chat.deleteConfirm")}
                </Button>
                <Button
                  size="icon-sm" className="size-6"
                  variant="ghost"
                  aria-label={t("common.cancel")}
                  onClick={() => setConfirming(false)}
                >
                  <X className="size-3" aria-hidden />
                </Button>
              </span>
            ) : (
              <Button
                size="icon-sm" className="size-6"
                variant="ghost"
                aria-label={t("chat.delete")}
                title={t("chat.delete")}
                onClick={() => setConfirming(true)}
                data-testid="message-delete"
              >
                <Trash2 className="size-3" aria-hidden />
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** What the copy action is doing, or why it stopped. */
type CopyState =
  | { status: "idle" }
  | { status: "copying" }
  | { status: "copied" }
  | { status: "error"; key: string };

/**
 * Only one picture write may be in flight across the whole feed. A newer
 * click (or a new proxy) aborts the older fetch/conversion and invalidates
 * its completion, so a late PNG cannot win over the picture the user chose
 * last. The generation also stops a stale success from leaving an old button
 * stuck in `copying`.
 */
let activeCopyController: AbortController | null = null;
let activeCopyGeneration = 0;

function ImageAttachment({
  attachment,
  proxy,
}: {
  attachment: AttachmentView;
  proxy: ChatProxyView;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const url = attachmentUrl(proxy, attachment.id);
  const copying = copyState.status === "copying";

  // A session change must cancel this component's copy and invalidate its
  // completion, including a write that the WebView has already accepted.
  useEffect(() => {
    const controller = abortRef.current;
    if (!controller || activeCopyController !== controller) {
      return;
    }
    activeCopyController = null;
    activeCopyGeneration += 1;
    controller.abort();
    setCopyState((state) =>
      state.status === "copying" ? { status: "idle" } : state,
    );
  }, [proxy.baseUrl, proxy.token]);

  // Unmount follows the same rule: no late completion may touch a view that
  // is gone or a session that has replaced it.
  useEffect(
    () => () => {
      const controller = abortRef.current;
      if (!controller || activeCopyController !== controller) {
        return;
      }
      activeCopyController = null;
      activeCopyGeneration += 1;
      controller.abort();
    },
    [],
  );

  // The confirmation is transient; an error stays until the next attempt.
  useEffect(() => {
    if (copyState.status !== "copied") {
      return;
    }
    const timer = window.setTimeout(() => setCopyState({ status: "idle" }), 4000);
    return () => window.clearTimeout(timer);
  }, [copyState.status]);

  async function copyImage() {
    if (copying) {
      return;
    }
    if (attachment.sizeBytes > MAX_COPY_IMAGE_BYTES) {
      setCopyState({ status: "error", key: "chat.copyImageTooLarge" });
      return;
    }
    if (
      attachment.width > 0 &&
      attachment.height > 0 &&
      attachment.width * attachment.height > MAX_COPY_IMAGE_PIXELS
    ) {
      setCopyState({ status: "error", key: "chat.copyImageTooLarge" });
      return;
    }
    activeCopyController?.abort();
    const controller = new AbortController();
    activeCopyController = controller;
    abortRef.current = controller;
    const generation = ++activeCopyGeneration;
    generationRef.current = generation;
    setCopyState({ status: "copying" });
    try {
      await copyPictureToClipboard(proxy, attachment.id, controller.signal);
      if (generation !== activeCopyGeneration) {
        // A newer picture or a new session owns the clipboard now.
        if (generationRef.current === generation) {
          setCopyState({ status: "idle" });
        }
        return;
      }
      if (controller.signal.aborted) {
        setCopyState({ status: "idle" });
        return;
      }
      setCopyState({ status: "copied" });
    } catch (error) {
      if (generation !== activeCopyGeneration) {
        if (generationRef.current === generation) {
          setCopyState({ status: "idle" });
        }
        return;
      }
      if (controller.signal.aborted) {
        setCopyState({ status: "idle" });
        return;
      }
      const key = copyImageErrorKey(error);
      setCopyState(key ? { status: "error", key } : { status: "idle" });
    } finally {
      if (activeCopyController === controller) {
        activeCopyController = null;
      }
    }
  }

  const status =
    copyState.status === "copied" ? (
      <p
        role="status"
        className="px-2.5 pb-1.5 text-[11px] text-success"
        data-testid="attachment-copy-status"
      >
        {t("chat.copyImageCopied")}
      </p>
    ) : copyState.status === "error" ? (
      <p
        role="alert"
        className="px-2.5 pb-1.5 text-[11px] text-danger"
        data-testid="attachment-copy-status"
      >
        {t(copyState.key)}
      </p>
    ) : null;

  const copyButton = (testId: string) => (
    <Button
      size="icon-sm"
      className="size-6"
      variant="ghost"
      aria-label={t("chat.copyImage")}
      title={t("chat.copyImage")}
      aria-busy={copying}
      disabled={copying}
      onClick={() => void copyImage()}
      data-testid={testId}
    >
      {copying ? (
        <Loader2 className="size-3" aria-hidden />
      ) : (
        <Copy className="size-3" aria-hidden />
      )}
    </Button>
  );

  return (
    <>
      <figure className="m-0 max-w-[320px] overflow-hidden rounded-lg border border-border bg-raised">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="block w-full transition-opacity duration-150 hover:opacity-90"
          aria-label={attachment.fileName}
          data-testid="attachment-image"
        >
          <img
            src={url}
            alt={attachment.fileName}
            loading="lazy"
            className="max-h-56 w-full object-contain"
            style={
              attachment.width > 0 && attachment.height > 0
                ? { aspectRatio: `${attachment.width} / ${attachment.height}` }
                : undefined
            }
          />
        </button>
        <figcaption className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-faint">
          <span className="min-w-0 truncate">{attachment.fileName}</span>
          <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
            {formatFileSize(attachment.sizeBytes)}
            {copyButton("attachment-image-copy")}
          </span>
        </figcaption>
        {/* One live region at a time: the dialog takes over while it is open. */}
        {open ? null : status}
      </figure>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="h-[calc(92vh/var(--fixed-scale))] w-[calc(96vw/var(--fixed-scale))] max-h-none max-w-none bg-background p-2"
          closeLabel={t("common.close")}
        >
          <div className="flex items-center gap-2 pr-9">
            <DialogTitle className="min-w-0 flex-1 truncate px-1 pb-1 text-[12px] text-muted">
              {attachment.fileName}
            </DialogTitle>
            {copyButton("attachment-image-copy-full")}
          </div>
          <DialogDescription className="sr-only">
            {t("chat.imagePreview")}
          </DialogDescription>
          {status}
          {/* The dialog fills the viewport; the image is contained, never
              stretched or cropped (stage P3: click opens it full screen). */}
          <img
            src={url}
            alt={attachment.fileName}
            className="min-h-0 flex-1 object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
