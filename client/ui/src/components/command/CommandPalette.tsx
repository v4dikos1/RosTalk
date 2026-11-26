import {
  LogOut,
  Mic,
  MicOff,
  Search,
  Settings2,
  Volume2,
  VolumeX,
  Hash,
  Server,
  ServerCog,
  Keyboard,
  Info,
  Palette,
  UserRound,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { coreApi } from "@/core";


import { flattenChannels } from "@/lib/channels";
import { adminTabIds } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { runCoreAction, useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().trim();
}

/** Shared keycap: the footer hints and the close hint read the same. */
const kbdClass =
  "rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-faint";

/**
 * Command palette (Ctrl+K): channels, actions and settings in one list with
 * complete keyboard navigation (ArrowUp/Down, Home/End, Enter, Escape).
 *
 * The body mounts only while the palette is open, so every invocation starts
 * with an empty query without a state-resetting effect.
 */
export function CommandPalette() {
  const open = useAppStore((state) => state.paletteOpen);
  if (!open) {
    return null;
  }
  return <CommandPaletteBody />;
}

function CommandPaletteBody() {
  const { t } = useTranslation();
  const close = useAppStore((state) => state.closePalette);
  const openSettings = useAppStore((state) => state.openSettings);
  const openServerSettings = useAppStore((state) => state.openServerSettings);
  const openServerList = useAppStore((state) => state.openServerList);
  const openInvite = useAppStore((state) => state.openInvite);
  const selectChannel = useAppStore((state) => state.selectChannel);
  const core = useCoreStore((state) => state.state);
  const settings = useSettingsStore((state) => state.settings);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];
    const channels = flattenChannels(core?.channels ?? []);
    for (const { channel, depth } of channels) {
      list.push({
        id: `channel-${channel.id}`,
        group: t("palette.groups.channels"),
        label: `${"\u00a0".repeat(depth * 2)}${channel.name}`,
        hint:
          channel.topic ||
          (channel.kind === "voice" ? t("palette.voiceChannel") : t("palette.textChannel")),
        icon: channel.kind === "voice" ? Volume2 : Hash,
        run: () => {
          selectChannel(channel.id);
          if (channel.kind === "voice") {
            void joinChannel(channel.id);
          }
          close();
        },
      });
    }

    const self = core?.users.find((user) => user.id === core.selfUserId);
    if (self) {
      list.push({
        id: "action-mic",
        group: t("palette.groups.actions"),
        label: self.voice.selfMuted ? t("palette.unmute") : t("palette.mute"),
        icon: self.voice.selfMuted ? Mic : MicOff,
        run: () => {
          void runCoreAction(() => coreApi.toggleVoiceState("mute"));
          close();
        },
      });
      list.push({
        id: "action-sound",
        group: t("palette.groups.actions"),
        label: self.voice.selfDeafened ? t("palette.undeafen") : t("palette.deafen"),
        icon: self.voice.selfDeafened ? Volume2 : VolumeX,
        run: () => {
          void runCoreAction(() => coreApi.toggleVoiceState("deafen"));
          close();
        },
      });
      if (self.channelId !== 0) {
        list.push({
          id: "action-leave",
          group: t("palette.groups.actions"),
          label: t("palette.leave"),
          icon: LogOut,
          run: () => {
            void runCoreAction(() => coreApi.leaveChannel());
            close();
          },
        });
      }
      list.push({
        id: "action-disconnect",
        group: t("palette.groups.actions"),
        label: t("main.disconnect"),
        icon: LogOut,
        run: () => {
          void runCoreAction(() => coreApi.disconnect());
          close();
        },
      });
    }

    for (const section of [
      { id: "profile", label: t("settings.tabs.profile"), icon: UserRound },
      { id: "appearance", label: t("settings.tabs.appearance"), icon: Palette },
      { id: "voice", label: t("settings.tabs.voice"), icon: Settings2 },
      { id: "hotkeys", label: t("settings.tabs.hotkeys"), icon: Keyboard },
      { id: "general", label: t("settings.tabs.general"), icon: Settings2 },
      { id: "about", label: t("settings.about.title"), icon: Info },
    ] as const) {
      list.push({
        id: `settings-${section.id}`,
        group: t("palette.groups.settings"),
        label: section.label,
        hint: t("palette.openSettings"),
        icon: section.icon,
        run: () => {
          openSettings(section.id);
          close();
        },
      });
    }

    const connected = core?.connection === "connected";
    if (connected) {
      list.push({
        id: "action-invite",
        group: t("palette.groups.server"),
        label: t("serverMenu.invite"),
        icon: UserPlus,
        run: () => {
          openInvite();
          close();
        },
      });
    }
    if (adminTabIds(core?.permissions?.server).length > 0) {
      list.push({
        id: "action-server-settings",
        group: t("palette.groups.server"),
        label: t("serverMenu.settings"),
        icon: ServerCog,
        run: () => {
          openServerSettings();
          close();
        },
      });
    }
    list.push({
      id: "action-switch-server",
      group: t("palette.groups.server"),
      label: t("profileMenu.switchServer"),
      icon: Server,
      run: () => {
        openServerList();
        close();
      },
    });

    for (const server of core?.servers ?? []) {
      if (server.id === core?.activeServerId) {
        continue;
      }
      list.push({
        id: `server-${server.id}`,
        group: t("palette.groups.servers"),
        label: server.name,
        hint: server.host,
        icon: Server,
        run: () => {
          if (settings?.nickname) {
            void runCoreAction(() =>
              coreApi.connect({
                target: { mode: "link", link: server.link },
                nickname: settings.nickname,
              }),
            );
          } else {
            useAppStore.getState().openConnect(server.link);
          }
          close();
        },
      });
    }
    return list;
  }, [
    core,
    close,
    openSettings,
    openServerSettings,
    openServerList,
    openInvite,
    selectChannel,
    settings,
    t,
  ]);

  const filtered = useMemo(() => {
    const needle = normalize(query);
    if (needle.length === 0) {
      return items;
    }
    return items.filter((item) =>
      normalize(`${item.label} ${item.hint ?? ""} ${item.group}`).includes(needle),
    );
  }, [items, query]);

  const activeIndex =
    filtered.length === 0 ? 0 : Math.min(active, filtered.length - 1);
  const groups = useMemo(() => {
    const result: { name: string; items: { item: PaletteItem; index: number }[] }[] =
      [];
    filtered.forEach((item, index) => {
      const last = result.at(-1);
      if (last && last.name === item.group) {
        last.items.push({ item, index });
      } else {
        result.push({ name: item.group, items: [{ item, index }] });
      }
    });
    return result;
  }, [filtered]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function runAt(index: number) {
    const item = filtered[index];
    if (item) {
      item.run();
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(
        filtered.length === 0 ? 0 : (activeIndex + 1) % filtered.length,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(
        filtered.length === 0
          ? 0
          : (activeIndex - 1 + filtered.length) % filtered.length,
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(activeIndex);
    }
  }

  const activeId = filtered[activeIndex]?.id ?? undefined;

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        showClose={false}
        className="top-[18%] w-[min(600px,94vw)] translate-y-0"
        data-testid="command-palette"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">{t("palette.title")}</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-faint" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("palette.placeholder")}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            data-testid="palette-input"
            className="h-11 min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-faint focus:outline-none"
          />
          <kbd className={kbdClass}>Esc</kbd>
        </div>

        <div
          ref={listRef}
          id="palette-list"
          role="listbox"
          aria-label={t("palette.title")}
          className="max-h-[360px] min-h-[120px] overflow-y-auto p-1.5"
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-faint">
              {t("palette.empty")}
            </p>
          ) : (
            groups.map((group) => (
              <div
                key={group.name}
                role="group"
                aria-label={group.name}
                data-testid={`palette-group-${group.name}`}
              >
                <p
                  aria-hidden
                  className="px-2 pb-1 pt-2 text-[11px] font-medium text-faint"
                >
                  {group.name}
                </p>
                {group.items.map(({ item, index }) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.id} role="presentation">
                      <button
                        type="button"
                        id={item.id}
                        role="option"
                        aria-selected={index === activeIndex}
                        data-index={index}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => runAt(index)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left",
                          index === activeIndex
                            ? "bg-active text-foreground"
                            : "text-muted hover:bg-hover",
                        )}
                      >
                        <Icon
                          className={cn(
                            "size-4 shrink-0",
                            index === activeIndex ? "text-accent" : "text-faint",
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {item.label}
                        </span>
                        {item.hint ? (
                          <span className="max-w-[45%] truncate text-[11px] text-faint">
                            {item.hint}
                          </span>
                        ) : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-border px-3 py-2 text-[10px] text-faint">
          <span className="flex items-center gap-1">
            <kbd className={kbdClass}>↑↓</kbd>
            {t("palette.hintMove")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className={kbdClass}>↵</kbd>
            {t("palette.hintRun")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className={kbdClass}>Esc</kbd>
            {t("palette.hintClose")}
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

async function joinChannel(channelId: number) {
  const ok = await runCoreAction(() => coreApi.joinChannel(channelId, null));
  if (ok) {
    const settings = useSettingsStore.getState().settings;
    if (settings) {
      await useSettingsStore.getState().update({ defaultChannelId: channelId });
    }
  }
}
