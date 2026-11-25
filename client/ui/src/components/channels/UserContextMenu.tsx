import { Ban, HeadphoneOff, ImageOff, LogIn, LogOut, MessageCircle, SlidersHorizontal, Volume1, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { coreApi } from "@/core";
import {
  memberBan,
  memberKick,
  memberSetDeafened,
  memberSetMuted,
  sendAdmin,
} from "@/lib/admin";
import { currentVoiceChannelId, joinVoiceChannel } from "@/lib/channels";
import { asCoreError, coreErrorText } from "@/lib/coreError";
import { avatarErrorKey, resetUserAvatar } from "@/lib/avatars";
import { hasExplicit, hasPermission, highestPosition } from "@/lib/permissions";
import { participantKey, participantPreference } from "@/lib/settings";
import { formatClock } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useAppStore, type UserMenuTarget } from "@/store/appStore";
import { useChatStore } from "@/store/chatStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Context menu of one user: their local volume 0–200 % and a local mute. These
 * are client-side preferences, not server moderation (design 5.4).
 *
 * Your own row shows the nickname, your state and a shortcut to the sound
 * settings: there is no point in muting yourself or changing your own volume.
 *
 * The body is keyed by the user id, so opening the menu for another person
 * starts from their saved preference without a state-resetting effect.
 */
export function UserContextMenu() {
  const target = useAppStore((state) => state.userMenu);
  if (!target) {
    return null;
  }
  return <UserContextMenuBody key={target.userId} target={target} />;
}

function UserContextMenuBody({ target }: { target: UserMenuTarget }) {
  const { t } = useTranslation();
  const close = useAppStore((state) => state.closeUserMenu);
  const openSettings = useAppStore((state) => state.openSettings);
  const openDm = useAppStore((state) => state.openDm);
  const state = useCoreStore((store) => store.state);
  const settings = useSettingsStore((store) => store.settings);
  const setParticipant = useSettingsStore((store) => store.setParticipant);
  const user = state?.users.find((item) => item.id === target.userId);
  const key = user ? participantKey(state?.server?.id ?? null, user.id) : "";
  const preference = participantPreference(settings, key);
  const [volume, setVolume] = useState(preference.volume);
  const [muted, setMuted] = useState(preference.muted);
  const [moderation, setModeration] = useState<"kick" | "ban" | null>(null);
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState(0);
  const [byKey, setByKey] = useState(true);
  const [byIp, setByIp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof asCoreError> | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const sliderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sliderRef.current?.focus();
  }, []);

  // Radix closes on Escape at the document level; the window listener keeps
  // the same behaviour when the key event is dispatched to the window.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    if (!key || target.userId === state?.selfUserId) {
      return;
    }
    const identity = `${target.userId}:voice`;
    const timer = window.setTimeout(() => {
      void setParticipant(key, volume, muted);
      void coreApi
        .setVoiceParticipantVolume(identity, volume / 100)
        .catch(() => {});
      void coreApi.setVoiceParticipantMuted(identity, muted).catch(() => {});
    }, 180);
    return () => window.clearTimeout(timer);
  }, [volume, muted, key, setParticipant, target.userId, state?.selfUserId]);

  if (!user) {
    return null;
  }

  const isSelf = user.id === state?.selfUserId;
  const serverPerms = state?.permissions?.server ?? [];
  const selfChannelId =
    state?.users.find((item) => item.id === state?.selfUserId)?.channelId ?? 0;
  const friendChannel =
    !isSelf && user.channelId > 0
      ? state?.channels.find((channel) => channel.id === user.channelId)
      : undefined;
  const friendPerms = friendChannel
    ? state?.permissions?.channels.find(
        (entry) => entry.channelId === friendChannel.id,
      )?.permissions
    : undefined;
  // The server still authorises the join; this only keeps a menu item that is
  // guaranteed to be rejected out of the way (stage 2.4, same rule as the tree).
  const canJoinFriend =
    friendChannel !== undefined &&
    friendChannel.kind === "voice" &&
    friendChannel.id !== selfChannelId &&
    (friendPerms === undefined || hasPermission(friendPerms, "joinChannel"));
  const manageServer = hasExplicit(serverPerms, "manageServer");
  const actor = state?.users.find((item) => item.id === state?.selfUserId);
  const actorHighest = actor ? highestPosition(actor.roleIds, state?.roles ?? []) : -1;
  const targetHighest = highestPosition(user.roleIds, state?.roles ?? []);
  const canAct = !isSelf && (manageServer || targetHighest < actorHighest);
  const showKick = canAct && (manageServer || serverPerms.includes("kick"));
  const showBan = canAct && (manageServer || serverPerms.includes("ban"));
  const showMute = canAct && (manageServer || serverPerms.includes("muteMembers"));
  const showDeafen = canAct && (manageServer || serverPerms.includes("deafenMembers"));
  const showResetAvatar = !isSelf && manageServer && user.avatarHash !== "";

  const width = 264;

  async function joinFriend() {
    if (!friendChannel) {
      return;
    }
    const fromId = currentVoiceChannelId();
    const fromName =
      fromId !== null
        ? state?.channels.find((channel) => channel.id === fromId)?.name
        : undefined;
    close();
    const joined = await joinVoiceChannel(friendChannel.id);
    if (
      !joined ||
      fromId === null ||
      fromId === friendChannel.id ||
      !fromName
    ) {
      return;
    }
    useChatStore.getState().pushNotice({
      key: null,
      title: t("tree.joinUserToastTitle", { channel: friendChannel.name }),
      body: t("tree.joinUserMoved", {
        from: fromName,
        to: friendChannel.name,
      }),
      mention: false,
      voice: true,
    });
  }

  async function runModeration(kind: "kick" | "ban") {
    if (busy || !user) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendAdmin(
        kind === "kick"
          ? memberKick(user.id, reason)
          : memberBan({
              userId: user.id,
              reason,
              expiresInSeconds: duration,
              byKey,
              byIp,
            }),
      );
      setModeration(null);
      setReason("");
      close();
    } catch (failure) {
      setError(asCoreError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function runResetAvatar() {
    if (busy || !user) {
      return;
    }
    setBusy(true);
    setAvatarError(null);
    try {
      const proxy = useChatStore.getState().proxy ?? (await coreApi.chatProxy());
      if (!proxy) {
        throw new Error("chat proxy is not ready");
      }
      await resetUserAvatar(proxy, user.id);
      close();
    } catch (failure) {
      setAvatarError(avatarErrorKey(failure));
    } finally {
      setBusy(false);
    }
  }

  const status = user.voice.away
    ? t("users.away")
    : user.voice.serverDeafened || user.voice.selfDeafened
      ? t("users.soundMuted")
      : user.voice.serverMuted || user.voice.selfMuted
        ? t("users.micMuted")
        : user.streaming
          ? t("users.streaming")
          : user.connectedAtUnixMs > 0
            ? t("userMenu.connectedAt", {
                time: formatClock(
                  user.connectedAtUnixMs,
                  settings?.locale ?? "ru",
                ),
              })
            : "";

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: target.x,
            top: target.y,
            width: 1,
            height: 1,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        role="dialog"
        aria-label={t("userMenu.title", { name: user.nickname })}
        data-testid="user-menu"
        style={{ width }}
        className="flex flex-col gap-2 p-2.5"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border pb-1.5">
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-semibold text-foreground">
              {isSelf ? t("users.you") : user.nickname}
            </span>
            {status ? (
              <span className="block truncate text-[10px] text-faint">
                {status}
              </span>
            ) : null}
          </span>
        </div>

        {isSelf ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openSettings("voice");
              close();
            }}
            data-testid="user-menu-audio-settings"
            className="flex h-8 items-center gap-2 rounded-sm px-2 text-left text-[12px] text-muted hover:bg-hover hover:text-foreground"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
            {t("userMenu.audioSettings")}
          </button>
        ) : null}

        {showKick || showBan || showMute || showDeafen || showResetAvatar ? (
          <div className="border-b border-border pb-1.5">
            <p className="mb-1 px-1 text-[11px] font-medium text-faint">
              {t("userMenu.moderation")}
            </p>
            <div className="flex flex-wrap gap-1">
              {showMute ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    void sendAdmin(memberSetMuted(user.id, !user.voice.serverMuted))
                      .then(() => close())
                      .catch((failure) => setError(asCoreError(failure)));
                  }}
                >
                  <VolumeX className="size-3" aria-hidden />
                  {user.voice.serverMuted ? t("userMenu.unserverMute") : t("userMenu.serverMute")}
                </Button>
              ) : null}
              {showDeafen ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    void sendAdmin(memberSetDeafened(user.id, !user.voice.serverDeafened))
                      .then(() => close())
                      .catch((failure) => setError(asCoreError(failure)));
                  }}
                >
                  <HeadphoneOff className="size-3" aria-hidden />
                  {user.voice.serverDeafened ? t("userMenu.unserverDeafen") : t("userMenu.serverDeafen")}
                </Button>
              ) : null}
              {showKick ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setModeration(moderation === "kick" ? null : "kick")}
                  data-testid="user-menu-kick"
                >
                  <LogOut className="size-3" aria-hidden />
                  {t("userMenu.kick")}
                </Button>
              ) : null}
              {showBan ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-danger hover:text-danger"
                  onClick={() => setModeration(moderation === "ban" ? null : "ban")}
                  data-testid="user-menu-ban"
                >
                  <Ban className="size-3" aria-hidden />
                  {t("userMenu.ban")}
                </Button>
              ) : null}
              {showResetAvatar ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void runResetAvatar()}
                  data-testid="user-menu-reset-avatar"
                >
                  <ImageOff className="size-3" aria-hidden />
                  {t("userMenu.resetAvatar")}
                </Button>
              ) : null}
            </div>
            {avatarError ? (
              <p role="alert" className="px-1 text-[10px] text-danger">
                {t(avatarError)}
              </p>
            ) : null}
            {moderation ? (
              <div className="mt-1 space-y-1 px-1">
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("userMenu.reason")}
                  maxLength={256}
                  data-testid="user-menu-reason"
                />
                {moderation === "ban" ? (
                  <div className="space-y-0.5">
                    <div className="flex h-8 items-center justify-between gap-2 text-[11px] text-muted">
                      <span>{t("userMenu.byKey")}</span>
                      <Switch
                        checked={byKey}
                        onCheckedChange={setByKey}
                        aria-label={t("userMenu.byKey")}
                        data-testid="user-menu-by-key"
                      />
                    </div>
                    <div className="flex h-8 items-center justify-between gap-2 text-[11px] text-muted">
                      <span>{t("userMenu.byIp")}</span>
                      <Switch
                        checked={byIp}
                        onCheckedChange={setByIp}
                        aria-label={t("userMenu.byIp")}
                        data-testid="user-menu-by-ip"
                      />
                    </div>
                    <div className="flex h-8 items-center justify-between gap-2 text-[11px] text-muted">
                      <span>{t("userMenu.duration")}</span>
                      <Select
                        value={duration}
                        onChange={(event) => setDuration(Number(event.target.value))}
                        className="h-7 w-32 text-[11px]"
                        aria-label={t("userMenu.duration")}
                      >
                        <option value={0}>{t("userMenu.permanent")}</option>
                        <option value={3600}>{t("userMenu.hour")}</option>
                        <option value={86400}>{t("userMenu.day")}</option>
                        <option value={604800}>{t("userMenu.week")}</option>
                      </Select>
                    </div>
                  </div>
                ) : null}
                <div className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant={moderation === "ban" ? "danger" : "default"}
                    disabled={busy || (moderation === "ban" && !byKey && !byIp)}
                    onClick={() => void runModeration(moderation)}
                    data-testid="user-menu-confirm"
                  >
                    {moderation === "ban" ? t("userMenu.confirmBan") : t("userMenu.confirmKick")}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setModeration(null)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="px-1 text-[10px] text-danger" title={coreErrorText(error).detail}>
                {t(coreErrorText(error).key)}
              </p>
            ) : null}
          </div>
        ) : null}

        {canJoinFriend && friendChannel ? (
          <button
            type="button"
            role="menuitem"
            aria-label={t("tree.joinUser", { channel: friendChannel.name })}
            title={t("tree.joinUserHint", { name: user.nickname })}
            onClick={() => void joinFriend()}
            data-testid="user-menu-join"
            className="flex h-8 items-center gap-2 rounded-sm px-2 text-left text-[12px] text-muted hover:bg-hover hover:text-foreground"
          >
            <LogIn className="size-3.5" aria-hidden />
            {t("tree.joinUser", { channel: friendChannel.name })}
          </button>
        ) : null}

        {!isSelf ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openDm(user.id);
              close();
            }}
            data-testid="user-menu-dm"
            className="flex h-8 items-center gap-2 rounded-sm px-2 text-left text-[12px] text-muted hover:bg-hover hover:text-foreground"
          >
            <MessageCircle className="size-3.5" aria-hidden />
            {t("chat.sendDirect")}
          </button>
        ) : null}

        {!isSelf ? (
          <>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 text-muted">
                  <Volume1 className="size-3.5" aria-hidden />
                  {t("userMenu.volume")}
                </span>
                <span
                  className="tabular-nums text-foreground"
                  data-testid="user-menu-volume"
                >
                  {volume}%
                </span>
              </div>
              <Slider
                ref={sliderRef}
                min={0}
                max={200}
                step={5}
                value={volume}
                aria-label={t("userMenu.volume")}
                onChange={(event) => setVolume(Number(event.target.value))}
                data-testid="user-menu-slider"
              />
              <div className="flex justify-between text-[10px] text-faint">
                <span>0%</span>
                <span>100%</span>
                <span>200%</span>
              </div>
              <p className="text-[10px] text-faint">{t("userMenu.volumeHint")}</p>
            </div>

            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={muted}
              onClick={() => setMuted((current) => !current)}
              data-testid="user-menu-mute"
              className={cn(
                "flex h-8 items-center gap-2 rounded-sm px-2 text-left text-[12px]",
                muted
                  ? "bg-danger/15 text-danger"
                  : "text-muted hover:bg-hover hover:text-foreground",
              )}
            >
              <VolumeX className="size-3.5" aria-hidden />
              {muted ? t("userMenu.unmute") : t("userMenu.mute")}
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setVolume(100);
                setMuted(false);
              }}
              className="flex h-8 items-center rounded-sm px-2 text-left text-[11px] text-faint hover:bg-hover hover:text-foreground"
            >
              {t("userMenu.reset")}
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
