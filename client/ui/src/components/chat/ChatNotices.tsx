import { AtSign, MessageCircle, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { targetFromKey } from "@/lib/chat";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { useChatStore, type ChatNotice } from "@/store/chatStore";

/**
 * In-app notification for mentions and direct messages when the OS
 * notification is unavailable or was not granted. It is also the only
 * fallback in the fixture and browser modes.
 */
export function ChatNotices() {
  const notices = useChatStore((state) => state.notices);
  return (
    <div
      className="pointer-events-none fixed bottom-14 right-3 z-30 flex w-72 flex-col gap-1.5"
      aria-live="polite"
      aria-atomic="false"
      data-testid="chat-notices"
    >
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} />
      ))}
    </div>
  );
}

function Notice({ notice }: { notice: ChatNotice }) {
  const { t } = useTranslation();
  const dismiss = useChatStore((state) => state.dismissNotice);
  const openDm = useAppStore((state) => state.openDm);
  const selectChannel = useAppStore((state) => state.selectChannel);
  const setView = useAppStore((state) => state.setView);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(6000);

  useEffect(() => {
    if (paused) {
      return;
    }
    const started = Date.now();
    const timer = window.setTimeout(() => dismiss(notice.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(
        1000,
        remaining.current - (Date.now() - started),
      );
    };
  }, [dismiss, notice.id, paused]);

  function open() {
    if (!notice.key) {
      return;
    }
    const target = targetFromKey(notice.key);
    if (target.kind === "dm") {
      openDm(target.peerId);
    } else {
      selectChannel(target.channelId);
      setView("chat");
    }
    dismiss(notice.id);
  }

  const content = (
    <>
      <span className="block truncate text-[12px] font-semibold text-foreground">
        {notice.title}
      </span>
      {notice.body ? (
        <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-muted">
          {notice.body}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border bg-surface/95 p-2 shadow-panel backdrop-blur-sm animate-scale-in",
        notice.mention ? "border-danger/50" : "border-border",
      )}
      data-testid="chat-notice"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm",
          notice.mention
            ? "bg-danger/15 text-danger"
            : "bg-accent/15 text-accent",
        )}
      >
        {notice.voice ? (
          <Volume2 className="size-3.5" aria-hidden />
        ) : notice.mention ? (
          <AtSign className="size-3.5" aria-hidden />
        ) : (
          <MessageCircle className="size-3.5" aria-hidden />
        )}
      </span>
      {notice.key ? (
        <button
          type="button"
          onClick={open}
          className="min-w-0 flex-1 text-left"
        >
          {content}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{content}</div>
      )}
      <button
        type="button"
        onClick={() => dismiss(notice.id)}
        aria-label={t("common.dismiss")}
        className="flex size-4 shrink-0 items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-foreground"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}
