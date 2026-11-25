import { UploadCloud } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ChannelView, ChatTarget, UserView } from "@/core/api";
import { conversationKey, DEFAULT_MAX_UPLOAD_BYTES } from "@/lib/chat";
import { hasPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";

import { MessageComposer } from "./MessageComposer";
import { MessageList } from "./MessageList";
import { useChatUploads } from "./useChatUploads";

export interface ChatPanelProps {
  target: ChatTarget;
  channel?: ChannelView | undefined;
  peer?: UserView | undefined;
}

/**
 * Channel or direct-message chat: feed, composer and the drop target.
 * Permissions are advisory here; the server checks every send again.
 */
export function ChatPanel({ target, channel, peer }: ChatPanelProps) {
  const { t } = useTranslation();
  const key = conversationKey(target);
  const state = useCoreStore((store) => store.state);
  const proxy = useChatStore((store) => store.proxy);
  const setActive = useChatStore((store) => store.setActive);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const channelPermissions = useMemo(() => {
    if (!state || target.kind !== "channel") {
      return null;
    }
    return (
      state.permissions?.channels.find(
        (entry) => entry.channelId === target.channelId,
      )?.permissions ?? null
    );
  }, [state, target]);

  const directPermissions = useMemo(() => {
    if (!state) {
      return null;
    }
    // The server checks direct messages against the role union; the UI only
    // needs to know whether any channel grants the chat rights.
    const union = new Set<string>();
    for (const entry of state.permissions?.channels ?? []) {
      for (const permission of entry.permissions) {
        union.add(permission);
      }
    }
    return [...union];
  }, [state]);

  const permissions = target.kind === "channel" ? channelPermissions : directPermissions;
  const canSend = hasPermission(permissions, "sendMessages");
  const canAttach = hasPermission(permissions, "attachFiles");
  const canManage =
    target.kind === "channel" && hasPermission(permissions, "manageMessages");
  // The server owns the limit (stage P3); the constant is only a fallback
  // while a snapshot without the field is still in the store.
  const uploads = useChatUploads(
    target,
    canAttach,
    proxy,
    state?.server?.maxAttachmentBytes || DEFAULT_MAX_UPLOAD_BYTES,
  );

  useEffect(() => {
    setActive(key);
    return () => {
      setActive(null);
    };
  }, [key, setActive]);

  const placeholder =
    target.kind === "dm"
      ? t("chat.dmPlaceholder", {
          name:
            peer?.nickname ||
            state?.unread.find(
              (counter) => counter.peerUserId === target.peerId,
            )?.peerNickname ||
            "",
        })
      : t("chat.placeholder", { channel: channel?.name ?? "" });

  return (
    <section
      aria-label={channel?.name ?? peer?.nickname ?? t("chat.title")}
      className="relative flex min-h-0 flex-1 flex-col bg-background"
      data-testid="chat-panel"
      onDragEnter={(event) => {
        if (!canAttach || !event.dataTransfer.types.includes("Files")) {
          return;
        }
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (canAttach) {
          event.preventDefault();
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (!canAttach) {
          return;
        }
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        uploads.addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <MessageList
        key={key}
        target={target}
        canManage={canManage}
      />
      <MessageComposer
        target={target}
        placeholder={placeholder}
        canSend={canSend}
        canAttach={canAttach}
        uploads={uploads}
      />
      <div
        aria-hidden={!dragging}
        className={cn(
          "pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent/60 bg-background/85 transition-opacity duration-150",
          dragging ? "opacity-100" : "opacity-0",
        )}
      >
        <UploadCloud className="size-7 text-accent" aria-hidden />
        <p className="text-[12px] font-medium text-foreground">
          {t("chat.dropTitle")}
        </p>
        <p className="text-[11px] text-muted">{t("chat.dropHint")}</p>
      </div>
    </section>
  );
}
