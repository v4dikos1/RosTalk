import {
  ArrowLeftRight,
  ChevronUp,
  ImagePlus,
  LogOut,
  Settings2,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { UserAvatar } from "@/components/common/UserAvatar";
import { AvatarDialog } from "@/components/profile/AvatarDialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { windowChrome } from "@/core";
import { roleNameStyle } from "@/lib/roles";
import { formatAccelerator } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

const MENU_WIDTH = 224;

/**
 * The bottom-left "avatar + nickname + status" panel (stage P7).
 *
 * A click opens the profile menu: profile, avatar, settings, another server,
 * quit. Settings moved here from the voice control bar; the bar keeps
 * microphone, sound, stream and leaving the channel. The menu is a Radix
 * Popover, so it is portalled and never clipped by the bottom bar (stage P8);
 * the avatar crop dialog lives outside the popover, so closing the menu does
 * not unmount it (stage P11).
 */
export function ProfileMenu() {
  const { t } = useTranslation();
  const state = useCoreStore((store) => store.state);
  const settings = useSettingsStore((store) => store.settings);
  const voiceState = useVoiceStore((store) => store.state);
  const levels = useVoiceStore((store) => store.levels);
  const openSettings = useAppStore((store) => store.openSettings);
  const openServerList = useAppStore((store) => store.openServerList);
  const [open, setOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);

  const self = state?.users.find((user) => user.id === state.selfUserId);
  const connected = state?.connection === "connected";
  const micMuted =
    self?.voice.selfMuted === true || self?.voice.serverMuted === true;
  const transmitting =
    connected && !micMuted && (levels?.selfSpeaking ?? false);
  const displayName =
    self?.nickname ||
    state?.nickname ||
    settings?.nickname ||
    t("quality.offline");
  const status = transmitting
    ? t("controls.transmitting")
    : micMuted
      ? t("users.micMuted")
      : connected
        ? t("main.online")
        : null;
  const gate = voiceState?.gate;
  const pttMode = gate?.mode === "pushToTalk";
  const ptt = voiceState?.pushToTalk ?? null;
  const pttBinding =
    settings?.voice.hotkeys.find((item) => item.action === "pushToTalk")
      ?.accelerator ?? null;
  const pttBroken =
    pttMode && (ptt?.hook === "unavailable" || ptt?.hook === "unsupported");
  const pttUnbound = pttMode && pttBinding === null;

  function choose(action: "profile" | "settings" | "server" | "quit") {
    setOpen(false);
    if (action === "profile") {
      openSettings("profile");
    } else if (action === "settings") {
      openSettings("general");
    } else if (action === "server") {
      openServerList();
    } else {
      void windowChrome.quit().catch(() => {});
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="profile-panel"
            className="flex w-[236px] min-w-0 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors duration-150 hover:bg-hover"
          >
            <UserAvatar
              name={displayName}
              color={self?.color ?? null}
              serverId={state?.server?.id ?? null}
              userId={self?.id}
              avatarHash={self?.avatarHash ?? ""}
              speaking={transmitting}
              size="md"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span
                  className="min-w-0 truncate text-[13px] font-semibold text-foreground"
                  style={roleNameStyle(self?.color)}
                >
                  {displayName}
                </span>
                <ChevronUp
                  className="size-3 shrink-0 text-faint"
                  aria-hidden
                />
              </span>
              <span
                data-testid="profile-status"
                className={cn(
                  "block truncate text-[11px]",
                  transmitting
                    ? "text-accent"
                    : micMuted
                      ? "text-danger"
                      : connected
                        ? "text-success"
                        : "text-faint",
                )}
              >
                {status}
              </span>
              {pttMode ? (
                <span
                  data-testid="ptt-status"
                  title={pttBroken ? (ptt?.error ?? undefined) : undefined}
                  className={cn(
                    "block truncate text-[10px]",
                    pttBroken ? "text-danger" : "text-muted",
                  )}
                >
                  {pttBroken
                    ? t("controls.pttUnavailable")
                    : pttUnbound
                      ? t("voice.pttUnbound")
                      : t("controls.pttBinding", {
                          binding: formatAccelerator(
                            ptt?.binding ?? "",
                            t("controls.mouseSideButton"),
                          ),
                        })}
                </span>
              ) : null}
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          role="menu"
          aria-label={t("profileMenu.title")}
          data-testid="profile-menu"
          side="top"
          align="start"
          style={{ width: MENU_WIDTH }}
          className="p-1.5"
        >
          <div className="mb-1 flex items-center gap-2 border-b border-border px-1.5 pb-2 pt-1">
            <UserAvatar
              name={displayName}
              color={self?.color ?? null}
              serverId={state?.server?.id ?? null}
              userId={self?.id}
              avatarHash={self?.avatarHash ?? ""}
              size="lg"
            />
            <span className="min-w-0">
              <span
                className="block truncate text-[13px] font-semibold text-foreground"
                style={roleNameStyle(self?.color)}
              >
                {displayName}
              </span>
              <span
                data-testid="profile-menu-status"
                className="block truncate text-[11px] text-muted"
              >
                {status}
              </span>
            </span>
          </div>
          <MenuItem
            icon={UserRound}
            label={t("profileMenu.profile")}
            testId="profile-menu-profile"
            onClick={() => choose("profile")}
          />
          <MenuItem
            icon={ImagePlus}
            label={t("profileMenu.changeAvatar")}
            testId="profile-menu-avatar"
            onClick={() => {
              setOpen(false);
              setAvatarOpen(true);
            }}
          />
          <MenuItem
            icon={Settings2}
            label={t("profileMenu.settings")}
            testId="profile-menu-settings"
            onClick={() => choose("settings")}
          />
          <MenuItem
            icon={ArrowLeftRight}
            label={t("profileMenu.switchServer")}
            testId="profile-menu-switch-server"
            onClick={() => choose("server")}
          />
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={LogOut}
            label={t("profileMenu.quit")}
            testId="profile-menu-quit"
            danger
            onClick={() => choose("quit")}
          />
        </PopoverContent>
      </Popover>
      <AvatarDialog open={avatarOpen} onOpenChange={setAvatarOpen} />
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  testId,
  onClick,
  danger = false,
}: {
  icon: typeof UserRound;
  label: string;
  testId: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px]",
        danger
          ? "text-danger hover:bg-danger/15"
          : "text-muted hover:bg-hover hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}
