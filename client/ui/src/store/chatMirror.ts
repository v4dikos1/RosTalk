import { coreApi } from "@/core";
import type { CoreEvent, MessageView } from "@/core/api";
import { playMentionSound } from "@/core/mentionSound";
import { i18n } from "@/i18n";
import { messageConversationKey } from "@/lib/chat";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Chat mirror: forwards stored messages into the per-conversation cache,
 * advances read markers and raises mention/DM notifications (stage 4.1).
 *
 * The core remains the source of truth. This module never creates messages and
 * never talks to the server directly: history and attachments go through the
 * loopback proxy, live messages arrive as core deltas.
 *
 * Chat history is not part of the core snapshot (ADR 0022), so a re-established
 * session has a gap between the cached tail and the restored one. The cache is
 * therefore kept and marked stale on every new snapshot; the open conversation
 * reloads its first page and merges it. Only switching to another server drops
 * the cache, because conversations of two servers must never mix.
 */
export function startChatMirror(): () => void {
  // Bookmark id (`host:port`) of the server the cache belongs to. A `reset`
  // for the same bookmark is a disconnect and a reconnect, not a change of
  // server. The stable server id catches a re-provisioned server on the same
  // address.
  let serverScope: string | null = null;
  let serverId: string | null = null;
  void refreshProxy();
  const unsubscribe = coreApi.subscribe((event: CoreEvent) => {
    if (event.type === "snapshot") {
      const snapshot = event.payload;
      const nextScope = snapshot.activeServerId ?? null;
      const nextServerId = snapshot.server?.id ?? null;
      if (
        isAnotherServer(serverScope, nextScope) ||
        isAnotherServer(serverId, nextServerId)
      ) {
        useChatStore.getState().clear();
      }
      serverScope = nextScope;
      serverId = nextServerId;
      // A snapshot follows every successful connect, including a reconnect.
      // Live deltas that were missed meanwhile are not replayed, so the open
      // feed reloads its first page instead of showing a silent gap.
      useChatStore.getState().markStale();
      requestNotificationPermission();
      void refreshProxy();
      return;
    }
    const delta = event.payload;
    switch (delta.type) {
      case "connection":
        if (delta.payload.connection === "connected") {
          void refreshProxy();
        } else if (
          delta.payload.connection === "disconnected" ||
          delta.payload.connection === "reconnecting"
        ) {
          useChatStore.getState().setProxy(null);
        }
        break;
      case "messageCreated": {
        const self = useCoreStore.getState().state?.selfUserId ?? 0;
        useChatStore.getState().applyMessage(delta.payload, self);
        onIncoming(delta.payload, self);
        break;
      }
      case "messageUpdated":
        useChatStore
          .getState()
          .applyMessage(delta.payload, useCoreStore.getState().state?.selfUserId ?? 0);
        break;
      case "messageDeleted":
        useChatStore
          .getState()
          .removeMessage(delta.payload, useCoreStore.getState().state?.selfUserId ?? 0);
        break;
      case "reset": {
        const nextScope = delta.payload.activeServerId ?? null;
        if (isAnotherServer(serverScope, nextScope)) {
          // A different server: the cached conversations belong to the old one.
          useChatStore.getState().clear();
        } else {
          // Same server (or the scope is not known yet): the cache is still
          // this server's, it is just no longer guaranteed to be current.
          useChatStore.getState().setProxy(null);
          useChatStore.getState().markStale();
        }
        serverScope = nextScope;
        // A reset only names the bookmark. The stable server id arrives with
        // the next snapshot; until then there is nothing to compare it with.
        serverId = null;
        break;
      }
      default:
        break;
    }
  });
  return unsubscribe;
}

/** True only when both scopes are known and different. */
function isAnotherServer(previous: string | null, next: string | null): boolean {
  return previous !== null && next !== null && previous !== next;
}

/** The core starts the proxy right after Welcome; retry briefly. */
async function refreshProxy(attempt = 0): Promise<void> {
  const proxy = await coreApi.chatProxy().catch(() => null);
  if (proxy) {
    useChatStore.getState().setProxy(proxy);
    return;
  }
  if (attempt < 9) {
    window.setTimeout(() => void refreshProxy(attempt + 1), 150);
  } else {
    useChatStore.getState().setProxy(null);
  }
}

function onIncoming(message: MessageView, selfUserId: number): void {
  if (selfUserId === 0 || message.senderId === selfUserId) {
    return;
  }
  const key = messageConversationKey(message, selfUserId);
  const active = useChatStore.getState().activeKey;
  const visible = typeof document !== "undefined" && !document.hidden;
  if (active === key && visible) {
    void useChatStore.getState().markRead(targetOf(message, selfUserId), message.id);
  }

  const direct = message.channelId === 0;
  const mentioned = message.mentionUserIds.includes(selfUserId);
  // A mention gets its own embedded chime, even while the conversation is open
  // and focused. It follows the saved cue switches, like the core cue does:
  // a missing settings object means the defaults, which keep sounds on, and a
  // user who disabled sounds — or only the message group — hears nothing. Own
  // messages never ring, even if the server echoed the author's own tag back.
  // History pages never reach this mirror, so loading them cannot ring either.
  const sounds = useSettingsStore.getState().settings?.voice.sounds;
  if (
    mentioned &&
    message.senderId !== selfUserId &&
    (sounds?.enabled ?? true) &&
    (sounds?.messages ?? true)
  ) {
    playMentionSound(Date.now(), sounds?.volume ?? 100);
  }
  if (!direct && !mentioned) {
    return;
  }
  if (active === key && visible) {
    return;
  }

  const state = useCoreStore.getState().state;
  const channel = state?.channels.find((item) => item.id === message.channelId);
  const title = direct
    ? message.senderNickname
    : channel
      ? `#${channel.name}`
      : i18n.t("chat.title");
  const preview = message.body.trim() || i18n.t("chat.attachmentOnly");
  const body = `${message.senderNickname}: ${
    preview.length > 140 ? `${preview.slice(0, 139)}…` : preview
  }`;

  // One cue per message: a mention already used the UI chime, so only a plain
  // direct message asks the core engine for its cue.
  if (!mentioned) {
    void coreApi.playVoiceSound("directMessage").catch(() => {});
  }

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      // The cue is played by the core, so the system notification must stay
      // silent: two sounds for one message would be an echo (stage P10).
      new Notification(title, { body, silent: true });
      return;
    } catch {
      // Fall through to the in-app notice.
    }
  }
  useChatStore.getState().pushNotice({ key, title, body, mention: mentioned });
}

function targetOf(message: MessageView, selfUserId: number) {
  if (message.channelId !== 0) {
    return { kind: "channel" as const, channelId: message.channelId };
  }
  const peer =
    message.senderId === selfUserId ? message.recipientId : message.senderId;
  return { kind: "dm" as const, peerId: peer };
}

function requestNotificationPermission(): void {
  if (typeof Notification === "undefined") {
    return;
  }
  if (Notification.permission === "default") {
    // Browsers may refuse without a user gesture; the in-app notice is the
    // fallback and is always available.
    void Notification.requestPermission().catch(() => {});
  }
}
