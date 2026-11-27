import { FileText, Loader2, Paperclip, SendHorizontal, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { coreApi } from "@/core";
import type { ChatTarget, UserView } from "@/core/api";
import { formatFileSize } from "@/lib/chat";
import { composerMetrics } from "@/lib/composer";
import { cn } from "@/lib/utils";
import { runCoreAction } from "@/store/coreStore";

import { EmojiPicker } from "./EmojiPicker";
import type { ChatUploads } from "./useChatUploads";

export interface MessageComposerProps {
  target: ChatTarget;
  placeholder: string;
  canSend: boolean;
  canAttach: boolean;
  /** Online users offered after "@"; the server resolves the tag again. */
  mentionCandidates?: UserView[];
  uploads: ChatUploads;
}

/** At most this many people are offered at once; typing narrows the list. */
const MAX_MENTION_OPTIONS = 8;

/** Mirrors the textarea's maxLength; the server caps the body at 4000 runes. */
const MAX_DRAFT_LENGTH = 4000;

/** A tag starts after whitespace or opening punctuation, as on the server. */
const MENTION_BOUNDARY = /[\s([{<,;:.!?]/;

const NO_MENTION_CANDIDATES: UserView[] = [];

/**
 * Message input. Enter sends, Shift+Enter inserts a line break. Files can be
 * picked, pasted as an image or dropped on the panel; they are uploaded
 * through the loopback proxy before the message is sent.
 *
 * Typing "@" opens the people of the server; the arrow keys move, Enter or a
 * click inserts "@nick". The list only swallows Enter while it is open, so
 * Shift+Enter and a plain Enter on a closed list keep their meaning.
 */
export function MessageComposer({
  target,
  placeholder,
  canSend,
  canAttach,
  mentionCandidates = NO_MENTION_CANDIDATES,
  uploads,
}: MessageComposerProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  const [fieldHeight, setFieldHeight] = useState(32);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mentionMatches = useMemo(() => {
    if (!mention) {
      return [];
    }
    const query = mention.query.toLocaleLowerCase();
    return mentionCandidates
      .filter((user) => user.nickname.toLocaleLowerCase().startsWith(query))
      .slice(0, MAX_MENTION_OPTIONS);
  }, [mention, mentionCandidates]);
  const activeMention = Math.max(
    0,
    Math.min(mentionIndex, mentionMatches.length - 1),
  );

  const hasAttachments = uploads.pending.length > 0;
  const canSubmit =
    canSend &&
    !sending &&
    !uploads.uploading &&
    (draft.trim().length > 0 || uploads.readyIds.length > 0);

  // Grows to the cap and only then allows the native scrollbar (P31): an empty
  // or single-line field must stay scrollbar-free in WebView2 on Windows 10.
  function resizeField(element: HTMLTextAreaElement) {
    element.style.height = "auto";
    const metrics = composerMetrics(element.scrollHeight);
    element.style.height = `${metrics.height}px`;
    setOverflowing(metrics.overflowing);
    setFieldHeight(metrics.height);
  }

  // A tooltip anchored to a button starts at the button's top edge and the
  // textarea can be taller, so the offset grows with the field: the hint stays
  // above the whole composer instead of covering the text (P31).
  const tooltipOffset = Math.max(6, fieldHeight - 20);

  function insertEmoji(char: string) {
    const element = textareaRef.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? start;
    setDraft(draft.slice(0, start) + char + draft.slice(end));
    requestAnimationFrame(() => {
      const field = textareaRef.current;
      if (!field) {
        return;
      }
      field.focus();
      const caret = start + char.length;
      field.setSelectionRange(caret, caret);
      resizeField(field);
    });
  }

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
      setMention(null);
      uploads.clear();
      requestAnimationFrame(() => {
        const field = textareaRef.current;
        if (field) {
          field.focus();
          resizeField(field);
        }
      });
    }
    setSending(false);
  }

  /** Opens or closes the picker for the "@" left of the caret. */
  function syncMention(value: string, caret: number) {
    const at = value.lastIndexOf("@", caret - 1);
    const before = at > 0 ? value[at - 1] : " ";
    // `lastIndexOf` clamps a negative position to index 0, and a caret at the
    // "@" itself sits before the fragment: both must close the list, or Home
    // on a draft that starts with "@nick" would keep it open.
    if (at < 0 || caret <= at || !MENTION_BOUNDARY.test(before ?? "")) {
      setMention(null);
      return;
    }
    const query = value.slice(at + 1, caret);
    if (query.includes("\n")) {
      setMention(null);
      return;
    }
    if (mention && mention.start === at && mention.query === query) {
      return;
    }
    setMention({ start: at, query });
    setMentionIndex(0);
  }

  /**
   * Re-reads the caret after a click or a caret key. Moving out of the typed
   * fragment closes the list, so Enter sends the draft instead of replacing
   * text the caret already left.
   */
  function syncCaretMention() {
    const node = textareaRef.current;
    if (!node || !mention) {
      return;
    }
    syncMention(node.value, node.selectionStart ?? node.value.length);
  }

  /** Replaces the typed "@fragment" with "@nick " and keeps the caret after it. */
  function insertMention(user: UserView) {
    if (!mention) {
      return;
    }
    // The replaced range follows the selected nickname, not a boundary scan:
    // nicknames may contain spaces, so only the characters that still match
    // the nickname belong to the fragment. A caret inside the fragment, a
    // half-typed second word and text after the fragment all stay correct.
    const nick = user.nickname.toLowerCase();
    const fragmentStart = mention.start + 1;
    let end = fragmentStart;
    while (
      end < draft.length &&
      nick.startsWith(draft.slice(fragmentStart, end + 1).toLowerCase())
    ) {
      end += 1;
    }
    const next = `${draft.slice(0, mention.start)}@${user.nickname} ${draft.slice(end)}`;
    if (next.length > MAX_DRAFT_LENGTH) {
      // The tag does not fit: keep the valid draft intact instead of growing
      // past maxLength and having the server reject the whole message.
      setMention(null);
      return;
    }
    const position = mention.start + user.nickname.length + 2;
    setDraft(next);
    setMention(null);
    window.requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) {
        return;
      }
      node.focus();
      node.setSelectionRange(position, position);
      resizeField(node);
    });
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
    <div className="shrink-0 px-4 pb-4 pt-1" data-testid="message-composer">
      {hasAttachments ? (
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

      <div className="relative flex w-full items-end gap-2 rounded-lg border border-border bg-raised p-1.5">
        {mentionMatches.length > 0 ? (
          <ul
            role="listbox"
            aria-label={t("chat.mentionsList")}
            className="absolute bottom-full left-0 z-20 mb-1 max-h-48 w-64 overflow-y-auto rounded-md border border-border bg-raised py-1 shadow-lg"
            data-testid="mention-list"
          >
            {mentionMatches.map((user, index) => (
              <li
                key={user.id}
                role="option"
                aria-selected={index === activeMention}
                className={cn(
                  "cursor-pointer truncate px-2 py-1 text-[12px]",
                  index === activeMention
                    ? "bg-hover text-foreground"
                    : "text-muted",
                )}
                style={user.color ? { color: user.color } : undefined}
                // Keep the focus in the textarea so the list does not close
                // before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(user)}
                data-testid={`mention-option-${user.id}`}
              >
                @{user.nickname}
              </li>
            ))}
          </ul>
        ) : null}
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
            <span className="flex shrink-0">
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
          <TooltipContent
            side="top"
            align="start"
            sideOffset={tooltipOffset}
            collisionPadding={8}
          >
            {canAttach ? t("chat.attachHint") : t("chat.cannotAttach")}
          </TooltipContent>
        </Tooltip>

        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          maxLength={MAX_DRAFT_LENGTH}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            syncMention(value, event.target.selectionStart ?? value.length);
            resizeField(event.currentTarget);
          }}
          onPaste={onPaste}
          onSelect={syncCaretMention}
          onKeyUp={syncCaretMention}
          onClick={syncCaretMention}
          onBlur={() => setMention(null)}
          onKeyDown={(event) => {
            const caret =
              event.currentTarget.selectionStart ??
              event.currentTarget.value.length;
            // The picker only swallows keys while the caret is inside the
            // synced query. A nickname may contain spaces, so a boundary scan
            // could not tell where the fragment ends; the query always reaches
            // the caret that produced it.
            const caretInMention =
              mention !== null &&
              caret > mention.start &&
              caret <= mention.start + 1 + mention.query.length;
            if (mention && event.key === "Escape") {
              event.preventDefault();
              setMention(null);
              return;
            }
            if (mentionMatches.length > 0 && caretInMention && !event.shiftKey) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIndex(
                  (index) => (index + 1) % mentionMatches.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIndex(
                  (index) =>
                    (index - 1 + mentionMatches.length) %
                    mentionMatches.length,
                );
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                // Enter picks a person; it does not send the draft yet.
                event.preventDefault();
                const user = mentionMatches[activeMention];
                if (user) {
                  insertMention(user);
                }
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          disabled={!canSend}
          placeholder={canSend ? placeholder : t("chat.cannotSend")}
          aria-label={placeholder}
          data-testid="chat-input"
          className={cn(
            "max-h-[132px] min-h-8 flex-1 resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-[13px] text-foreground outline-none select-text placeholder:text-faint focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60",
            overflowing ? "overflow-y-auto" : "overflow-y-hidden",
          )}
        />

        <EmojiPicker onSelect={insertEmoji} />

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex shrink-0">
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
          <TooltipContent
            side="top"
            align="end"
            sideOffset={tooltipOffset}
            collisionPadding={8}
          >
            {t("chat.sendHint")}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
