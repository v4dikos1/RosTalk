import { Download, Pencil, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { UserAvatar } from "@/components/common/UserAvatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AttachmentView, ChatProxyView, MessageView } from "@/core/api";
import { attachmentUrl, formatFileSize } from "@/lib/chat";
import { Markup } from "@/lib/markup";
import { roleNameStyle } from "@/lib/roles";
import { formatClock } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/settingsStore";

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
            <span
              className="truncate text-[13px] font-medium text-foreground"
              style={roleNameStyle(authorColor)}
            >
              {message.senderNickname}
            </span>
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
            <Markup text={message.body} />
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

function ImageAttachment({
  attachment,
  proxy,
}: {
  attachment: AttachmentView;
  proxy: ChatProxyView;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const url = attachmentUrl(proxy, attachment.id);
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
          <span className="shrink-0 tabular-nums">
            {formatFileSize(attachment.sizeBytes)}
          </span>
        </figcaption>
      </figure>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="h-[calc(92vh/var(--fixed-scale))] w-[calc(96vw/var(--fixed-scale))] max-h-none max-w-none bg-background p-2"
          closeLabel={t("common.close")}
        >
          <DialogTitle className="px-1 pb-1 text-[12px] text-muted">
            {attachment.fileName}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("chat.imagePreview")}
          </DialogDescription>
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
