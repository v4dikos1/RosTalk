import {
  ArrowLeft,
  Crown,
  Eye,
  Hash,
  HeadphoneOff,
  Lock,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  MoonStar,
  Paperclip,
  Play,
  Radio,
  SendHorizontal,
  Settings2,
  Shield,
  UserPlus,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ChannelTree } from "@/components/channels/ChannelTree";
import { UserRow } from "@/components/channels/UserRow";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { ControlBar } from "@/components/controls/ControlBar";
import { LiveBadge } from "@/components/streams/LiveBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_APPEARANCE, presetForTheme } from "@/lib/appearance";
import { fixtureState } from "@/mock/fixtures";
import { useAppStore } from "@/store/appStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { ThemePreference } from "@/core/api";

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-md border border-border bg-surface ${className ?? ""}`}
    >
      <header className="border-b border-border px-4 py-2.5">
        <h2 className="text-[12px] font-semibold text-muted">
          {title}
        </h2>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const swatches = [
  { nameKey: "gallery.accent", variable: "--accent" },
  { nameKey: "gallery.surface", variable: "--surface" },
  { nameKey: "gallery.border", variable: "--border" },
  { nameKey: "gallery.text", variable: "--foreground" },
  { nameKey: "gallery.danger", variable: "--danger" },
  { nameKey: "gallery.success", variable: "--success" },
  { nameKey: "gallery.warning", variable: "--warning" },
] as const;

const icons = [
  { icon: Mic, label: "Mic" },
  { icon: MicOff, label: "MicOff" },
  { icon: Volume2, label: "Volume2" },
  { icon: VolumeX, label: "VolumeX" },
  { icon: HeadphoneOff, label: "HeadphoneOff" },
  { icon: MoonStar, label: "Away" },
  { icon: MonitorUp, label: "Stream" },
  { icon: Radio, label: "Live" },
  { icon: Settings2, label: "Settings" },
  { icon: Hash, label: "Text" },
  { icon: Lock, label: "Locked" },
  { icon: Crown, label: "Owner" },
  { icon: Shield, label: "Admin" },
  { icon: MessageSquare, label: "Chat" },
  { icon: SendHorizontal, label: "Send" },
  { icon: Paperclip, label: "Attach" },
  { icon: Eye, label: "Viewers" },
  { icon: Play, label: "Play" },
  { icon: UserPlus, label: "Invite" },
] as const;

export function GalleryPage() {
  const { t } = useTranslation();
  const theme = useSettingsStore((state) => state.settings?.theme ?? "dark");
  const appearance = useSettingsStore((state) => state.settings?.appearance);
  const locale = useSettingsStore((state) => state.settings?.locale ?? "ru");
  const updateSettings = useSettingsStore((state) => state.update);
  // `theme` is derived from the preset; switching here picks the preset that
  // matches the requested scheme instead of writing the derived field.
  const setTheme = (value: ThemePreference) =>
    void updateSettings({
      appearance: {
        ...(appearance ?? DEFAULT_APPEARANCE),
        preset: presetForTheme(value),
      },
    });
  const setLocale = (value: "ru" | "en") => void updateSettings({ locale: value });
  const selectedChannelId = useAppStore((state) => state.selectedChannelId);
  const selectChannel = useAppStore((state) => state.selectChannel);
  const [demoSwitch, setDemoSwitch] = useState(true);

  function backToMock() {
    window.location.hash = "";
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <Button variant="secondary" size="sm" onClick={backToMock}>
          <ArrowLeft className="size-3.5" aria-hidden />
          {t("gallery.back")}
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold">
            {t("gallery.title")}
          </h1>
          <p className="truncate text-[11px] text-muted">
            {t("gallery.subtitle")}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<ThemePreference>
            value={theme}
            onChange={setTheme}
            options={[
              { value: "dark", label: t("settings.general.dark") },
              { value: "light", label: t("settings.general.light") },
            ]}
          />
          <div className="flex h-8 items-center gap-0.5 rounded-sm border border-border bg-background p-0.5">
            {(["ru", "en"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={locale === value}
                onClick={() => setLocale(value)}
                className={`flex h-6 items-center rounded-sm px-2 text-[12px] font-medium ${
                  locale === value
                    ? "bg-active text-foreground"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {value === "ru" ? "RU" : "EN"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-3 p-4 lg:grid-cols-2">
          <Section title={t("gallery.tokens")}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {swatches.map((swatch) => (
                <div
                  key={swatch.nameKey}
                  className="overflow-hidden rounded-sm border border-border"
                >
                  <div
                    className="h-10"
                    style={{ backgroundColor: `var(${swatch.variable})` }}
                  />
                  <p className="px-2 py-1.5 text-[11px] text-muted">
                    {t(swatch.nameKey)}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-faint">{t("gallery.rowNote")}</p>
          </Section>

          <Section title={t("gallery.typography")}>
            <div className="space-y-2">
              <p className="text-[18px] font-semibold">RosTalk — 18 / 600</p>
              <p className="text-[14px] font-semibold">
                {t("mock.server.name")} — 14 / 600
              </p>
              <p className="text-[13px]">
                {t("mock.messages.general1")} — 13 / 400
              </p>
              <p className="text-[12px] text-faint">
                {t("mock.channels.generalTopic")} — 12 / faint
              </p>
              <p className="text-[10px] text-faint">
                {t("main.today")} — 10
              </p>
            </div>
          </Section>

          <Section title={t("gallery.buttons")}>
            <div className="flex flex-wrap items-center gap-2">
              <Button>{t("gallery.primary")}</Button>
              <Button variant="secondary">{t("gallery.secondary")}</Button>
              <Button variant="ghost">{t("gallery.ghost")}</Button>
              <Button variant="outline">{t("gallery.outline")}</Button>
              <Button variant="danger">{t("gallery.dangerButton")}</Button>
              <Button disabled>{t("gallery.disabled")}</Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge>{t("streams.live")}</Badge>
              <Badge variant="secondary">2</Badge>
              <Badge variant="success">{t("main.online")}</Badge>
              <Badge variant="danger">{t("users.micMuted")}</Badge>
            </div>
          </Section>

          <Section title={t("gallery.live")}>
            <div className="flex flex-wrap items-center gap-3">
              <LiveBadge />
              <LiveBadge count={3} />
              <span className="flex items-center gap-2 rounded-md bg-black px-2 py-1">
                <LiveBadge variant="icon" />
                <LiveBadge variant="icon" count={12} />
              </span>
              <span className="flex items-center gap-2 rounded-md bg-black px-2 py-1">
                <LiveBadge onMedia />
                <LiveBadge onMedia count={2} />
              </span>
            </div>
            <p className="mt-3 text-[11px] text-faint">
              {t("gallery.liveNote")}
            </p>
          </Section>

          <Section title={t("gallery.inputs")}>
            <div className="space-y-3">
              <Input placeholder={t("gallery.placeholder")} />
              <div className="flex items-center gap-3">
                <Switch
                  checked={demoSwitch}
                  onCheckedChange={setDemoSwitch}
                  aria-label={t("settings.general.compact")}
                />
                <span className="text-[12px] text-muted">
                  {t("settings.general.compact")}
                </span>
              </div>
            </div>
          </Section>

          <Section title={t("gallery.statuses")}>
            <div className="divide-y divide-border rounded-sm border border-border">
              {fixtureState.users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  isSelf={user.id === fixtureState.selfUserId}
                  roles={fixtureState.roles}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint">
              <span>{t("users.speaking")}</span>
              <span>{t("users.micMuted")}</span>
              <span>{t("users.soundMuted")}</span>
              <span>{t("users.away")}</span>
              <span>{t("users.streaming")}</span>
            </div>
          </Section>

          <Section title={t("gallery.states")}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="overflow-hidden rounded-sm border border-border">
                <EmptyState
                  title={t("gallery.emptyTitle")}
                  description={t("gallery.emptyHint")}
                />
              </div>
              <div className="overflow-hidden rounded-sm border border-border">
                <ErrorState
                  title={t("gallery.errorTitle")}
                  description={t("gallery.errorHint")}
                  action={
                    <Button size="sm" variant="secondary">
                      {t("gallery.retry")}
                    </Button>
                  }
                />
              </div>
            </div>
          </Section>

          <Section title={t("gallery.tree")}>
            <div className="h-[360px] overflow-y-auto rounded-sm border border-border bg-surface">
              <div className="p-1.5">
                <ChannelTree
                  channels={fixtureState.channels}
                  users={fixtureState.users}
                  roles={fixtureState.roles}
                  selfUserId={fixtureState.selfUserId}
                  selectedChannelId={selectedChannelId ?? 3}
                  onSelectChannel={selectChannel}
                />
              </div>
            </div>
          </Section>

          <Section title={t("gallery.controls")}>
            <div className="overflow-hidden rounded-sm border border-border">
              <ControlBar />
            </div>
          </Section>

          <Section title={t("gallery.icons")} className="lg:col-span-2">
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-10">
              {icons.map(({ icon: Icon, label }) => (
                <div
                  key={label}
                  className="flex flex-col items-center gap-1 rounded-sm border border-border bg-raised px-1 py-2 text-faint"
                >
                  <Icon className="size-4" aria-hidden />
                  <span className="text-[10px]">{label}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title={t("gallery.motion")} className="lg:col-span-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="animate-fade-in size-10 rounded-sm bg-accent/30" />
              <div className="animate-scale-in size-10 rounded-sm bg-success/30" />
              <div className="animate-slide-up size-10 rounded-sm bg-warning/30" />
              <p className="text-[12px] text-muted">{t("gallery.motionNote")}</p>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex h-8 items-center gap-0.5 rounded-sm border border-border bg-background p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`flex h-6 items-center rounded-sm px-2 text-[12px] font-medium ${
            value === option.value
              ? "bg-active text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
