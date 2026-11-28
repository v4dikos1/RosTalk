import { Check, Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingRow, SectionTitle } from "@/components/settings/SettingsPrimitives";
import { Segmented } from "@/components/ui/segmented";
import type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceFontScale,
  AppearancePreset,
  AppearanceRadius,
  AppearanceSettings,
} from "@/core/api";
import {
  APPEARANCE_ACCENTS,
  APPEARANCE_FONT_SCALES,
  APPEARANCE_PRESETS,
  presetTheme,
} from "@/lib/appearance";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Appearance settings: preset cards, accent, density, radius, scale and the
 * feed background.
 *
 * A preview card is a real `[data-preset]` element, so it renders with the
 * same tokens as the application instead of a hand-painted imitation.
 */
export function AppearanceSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((store) => store.settings);
  const update = useSettingsStore((store) => store.update);

  if (!settings) {
    return null;
  }
  const appearance = settings.appearance;
  const patch = (next: Partial<AppearanceSettings>) =>
    void update({ appearance: next });

  return (
    <div className="divide-y divide-border">
      <section>
        <SectionTitle>{t("settings.appearance.preset")}</SectionTitle>
        <p className="mb-2 text-[11px] text-muted">
          {t("settings.appearance.presetHint")}
        </p>
        <div
          className="flex flex-wrap gap-2.5"
          role="group"
          aria-label={t("settings.appearance.preset")}
        >
          {APPEARANCE_PRESETS.map((preset) => {
            const selected = appearance.preset === preset;
            return (
              <div key={preset} className="flex w-[132px] flex-col gap-1.5">
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={t(`settings.appearance.presets.${preset}`)}
                  data-testid={`appearance-preset-${preset}`}
                  onClick={() => patch({ preset })}
                  className={cn(
                    "relative block rounded-md border transition-opacity duration-150 hover:opacity-90",
                    selected ? "border-accent" : "border-border",
                  )}
                >
                  <PresetPreview preset={preset} />
                  {selected ? (
                    <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-sm">
                      <Check className="size-2.5" aria-hidden />
                    </span>
                  ) : null}
                </button>
                <span
                  className={cn(
                    "truncate text-[11px]",
                    selected ? "font-medium text-foreground" : "text-muted",
                  )}
                >
                  {t(`settings.appearance.presets.${preset}`)}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionTitle>{t("settings.appearance.accent")}</SectionTitle>
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label={t("settings.appearance.accent")}
        >
          {APPEARANCE_ACCENTS.map((accent) => (
            <AccentChoice
              key={accent}
              accent={accent}
              preset={appearance.preset}
              selected={appearance.accent === accent}
              onSelect={() => patch({ accent })}
            />
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          {t("settings.appearance.accentHint")}
        </p>
      </section>

      <section>
        <SectionTitle>{t("settings.appearance.layout")}</SectionTitle>
        <SettingRow
          label={t("settings.appearance.density")}
          hint={t("settings.appearance.densityHint")}
        >
          <Segmented<AppearanceDensity>
            value={appearance.density}
            onChange={(density) => patch({ density })}
            label={t("settings.appearance.density")}
            options={[
              {
                value: "comfortable",
                label: t("settings.appearance.densityComfortable"),
              },
              {
                value: "compact",
                label: t("settings.appearance.densityCompact"),
              },
            ]}
          />
        </SettingRow>
        <SettingRow label={t("settings.appearance.radius")}>
          <Segmented<AppearanceRadius>
            value={appearance.radius}
            onChange={(radius) => patch({ radius })}
            label={t("settings.appearance.radius")}
            options={[
              { value: "sharp", label: t("settings.appearance.radiusSharp") },
              {
                value: "default",
                label: t("settings.appearance.radiusDefault"),
              },
              { value: "round", label: t("settings.appearance.radiusRound") },
            ]}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.appearance.fontScale")}
          hint={t("settings.appearance.fontScaleHint")}
        >
          <Segmented<AppearanceFontScale>
            value={appearance.fontScale}
            onChange={(fontScale) => patch({ fontScale })}
            label={t("settings.appearance.fontScale")}
            options={APPEARANCE_FONT_SCALES.map((value) => ({
              value,
              label: `${value}%`,
            }))}
          />
        </SettingRow>
        <div className="flex items-start gap-1.5 pb-2 text-[11px] leading-snug text-faint">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <p>{t("settings.appearance.fontScaleNotice")}</p>
        </div>
      </section>
    </div>
  );
}

function AccentChoice({
  accent,
  preset,
  selected,
  onSelect,
}: {
  accent: AppearanceAccent;
  preset: AppearancePreset;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const label = t(`settings.appearance.accents.${accent}`);
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      data-testid={`appearance-accent-${accent}`}
      data-preset={preset}
      data-accent={accent === "auto" ? undefined : accent}
      data-theme={presetTheme(preset)}
      onClick={onSelect}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-sm border px-2 text-[11px] transition-colors duration-150",
        selected
          ? "border-accent bg-active text-foreground"
          : "border-border text-muted hover:bg-hover hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className="size-3 rounded-full bg-accent ring-1 ring-inset ring-black/15"
      />
      {label}
    </button>
  );
}

/** 132×88 miniature: sidebar, header and two message lines. */
function PresetPreview({ preset }: { preset: AppearancePreset }) {
  return (
    <div
      data-preset={preset}
      data-theme={presetTheme(preset)}
      className="flex h-[88px] w-[130px] gap-1 overflow-hidden rounded-[inherit] bg-chrome p-1.5"
      aria-hidden
    >
      <div className="flex w-6 shrink-0 flex-col gap-1 rounded-sm bg-surface p-1">
        <span className="h-1 w-full rounded-full bg-accent" />
        <span className="h-1 w-3/4 rounded-full bg-faint/70" />
        <span className="h-1 w-5/6 rounded-full bg-border" />
        <span className="mt-auto h-1 w-full rounded-full bg-border" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-2.5 shrink-0 items-center gap-1 rounded-sm bg-surface px-1">
          <span className="size-1 rounded-full bg-accent" />
          <span className="h-0.5 w-6 rounded-full bg-muted" />
          <span className="ml-auto h-0.5 w-3 rounded-full bg-faint" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 rounded-sm bg-background p-1">
          <div className="flex items-center gap-1">
            <span className="size-2.5 shrink-0 rounded-[2px] bg-accent/80" />
            <span className="h-0.5 w-7 rounded-full bg-foreground/80" />
          </div>
          <span className="h-0.5 w-full rounded-full bg-muted/70" />
          <span className="h-0.5 w-2/3 rounded-full bg-muted/70" />
          <div className="mt-auto flex items-center gap-1">
            <span className="size-1.5 shrink-0 rounded-[1px] bg-accent/70" />
            <span className="h-0.5 w-8 rounded-full bg-faint/80" />
          </div>
        </div>
      </div>
    </div>
  );
}
