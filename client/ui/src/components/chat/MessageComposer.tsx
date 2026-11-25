import { FileText, Loader2, Paperclip, SendHorizontal, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { coreApi } from "@/core";
import type { ChatTarget } from "@/core/api";
import { formatFileSize } from "@/lib/chat";
import { cn } from "@/lib/utils";
import { runCoreAction } from "@/store/coreStore";

import type { ChatUploads } from "./useChatUploads";

export interface MessageComposerProps {
  target: ChatTarget;
  placeholder: string;
  canSend: boolean;
  canAttach: boolean;
  uploads: ChatUploads;
}

/**
 * Message input. Enter sends, Shift+Enter inserts a line break. Files can be
 * picked, pasted as an image or dropped on the panel; they are uploaded
 * through the loopback proxy before the message is sent.
 */
export function MessageComposer({
  target,
  placeholder,
  canSend,
  canAttach,
  uploads,
}: MessageComposerProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasAttachments = uploads.pending.length > 0;
  const canSubmit =
    canSend &&
    !sending &&
    !uploads.uploading &&
    (draft.trim().length > 0 || uploads.readyIds.length > 0);

  async function send() {
    if (!canSubmit) {
      return;
    }
    setSending(true);
    const body = draft.trim();
    const ok = await runCoreAction(() =>
      coreApi.sendMessage(target, body, uploads.readyIds),
    );
    if (ok) {
      setDraft("");
      uploads.clear();
      textareaRef.current?.focus();
    }
    setSending(false);
  }

  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length > 0) {
      event.preventDefault();
      uploads.addFiles(images);
    }
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">      {hasAttachments ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid="upload-queue">
          {uploads.pending.map((item) => (
            <div
              key={item.localId}
              className={cn(
                "relative flex max-w-64 items-center gap-1.5 rounded-md border px-1.5 py-1",
                item.error
                  ? "border-danger/50 bg-danger/10"
                  : "border-border bg-raised",
              )}
              data-testid="upload-item"
            >
              {item.image && item.previewUrl ? (
                <img
                  src={item.previewUrl}
                  alt={item.name}
                  className="size-7 rounded-sm object-cover"
                />
              ) : (
                <FileText className="size-3.5 shrink-0 text-faint" aria-hidden />
              )}
              <span className="min-w-0">
                <span className="block truncate text-[11px] text-foreground">
                  {item.name}
                </span>
                <span className="block text-[10px] text-faint">
                  {item.error
                    ? t(`chat.uploadError.${item.error}`)
                    : item.id !== null
                      ? formatFileSize(item.size)
                      : `${Math.round(item.progress * 100)}%`}
                </span>
              </span>
              {item.id === null && item.error === null ? (
                <span className="h-0.5 w-10 overflow-hidden rounded-full bg-border">
                  <span
                    className="block h-full bg-accent transition-transform duration-150"
                    style={{ transform: `scaleX(${item.progress})`, transformOrigin: "left" }}
                  />
                </span>
              ) : null}
              <button
                type="button"
                aria-label={t("common.cancel")}
                onClick={() => uploads.remove(item.localId)}
                className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-foreground"
              >
                <X className="size-2.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex w-full items-end gap-2 rounded-lg border border-border bg-raised p-1.5">
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            uploads.addFiles(files);
            event.target.value = "";
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("chat.attach")}
                disabled={!canAttach}
                className="text-faint"
                onClick={() => inputRef.current?.click()}
                data-testid="chat-attach"
              >
                <Paperclip className="size-4" aria-hidden />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {canAttach ? t("chat.attachHint") : t("chat.cannotAttach")}
          </TooltipContent>
        </Tooltip>

        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          maxLength={4000}
          onChange={(event) => {
            setDraft(event.target.value);
            const element = event.currentTarget;
            element.style.height = "auto";
            element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
          }}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          disabled={!canSend}
          placeholder={canSend ? placeholder : t("chat.cannotSend")}
          aria-label={placeholder}
          data-testid="chat-input"
          className="max-h-[132px] min-h-8 flex-1 resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-[13px] text-foreground outline-none placeholder:text-faint focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                type="button"
                size="icon-sm"
                aria-label={t("chat.send")}
                disabled={!canSubmit}
                onClick={() => void send()}
                data-testid="chat-send"
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <SendHorizontal className="size-4" aria-hidden />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {t("chat.sendHint")}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
