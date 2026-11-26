import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardPaste,
  Fingerprint,
  Headphones,
  Link2,
  Mic,
  Moon,
  ServerCog,
  ShieldCheck,
  Sun,
  UserRound,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CertificatePanel } from "@/components/connect/CertificatePanel";
import { BrandMark } from "@/components/common/BrandMark";
import { ErrorNotice } from "@/components/common/ErrorNotice";
import { LevelMeter } from "@/components/voice/LevelMeter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { coreApi } from "@/core";
import type {
  ConnectTarget,
  CoreError,
  CoreState,
  LocalePreference,
  ServerProbeView,
} from "@/core/api";
import { asCoreError } from "@/lib/coreError";
import {
  isLoopbackHost,
  shortFingerprint,
  type InviteLinkError,
  parseInviteLink,
} from "@/lib/link";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useVoiceStore } from "@/store/voiceStore";

type Step = "link" | "nickname" | "microphone" | "diagnostics";
type LoginMode = "link" | "direct";

function firstVoiceChannel(state: CoreState, preferred: number | null) {
  const voice = state.channels
    .filter((channel) => channel.kind === "voice")
    .slice()
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.name.localeCompare(b.name) ||
        a.id - b.id,
    );
  if (preferred !== null) {
    const found = voice.find((channel) => channel.id === preferred);
    if (found) {
      return found;
    }
  }
  return voice.find(
    (channel) =>
      channel.userLimit === 0 || channel.userCount < channel.userLimit,
  );
}

function linkErrorMessage(error: InviteLinkError): string {
  switch (error) {
    case "invalidFingerprint":
      return "onboarding.link.fingerprintError";
    case "missingHost":
      return "onboarding.link.hostError";
    case "invalidLink":
      return "onboarding.link.invalidError";
  }
}

export function OnboardingWizard() {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding);
  const updateSettings = useSettingsStore((state) => state.update);
  const updateVoice = useSettingsStore((state) => state.updateVoice);
  const closeWizard = useAppStore((state) => state.closeWizard);
  const openHosting = useAppStore((state) => state.openHosting);
  const wizardLink = useAppStore((state) => state.wizardLink);
  const devices = useVoiceStore((state) => state.devices);
  const voiceState = useVoiceStore((state) => state.state);
  const levelDb = useVoiceStore((state) => state.levels?.selfLevelDb ?? -100);
  const selfSpeaking = useVoiceStore(
    (state) => state.levels?.selfSpeaking ?? false,
  );

  // A profile nickname is asked once and reused; the step only appears while
  // the profile is still empty.
  const steps: Step[] = useMemo(
    () =>
      (settings?.nickname ?? "").trim() === ""
        ? ["link", "nickname", "microphone", "diagnostics"]
        : ["link", "microphone", "diagnostics"],
    [settings?.nickname],
  );

  const [step, setStep] = useState<Step>("link");
  const [mode, setMode] = useState<LoginMode>("link");
  const [link, setLink] = useState(wizardLink ?? "");
  const [address, setAddress] = useState("");
  const [profileNickname, setProfileNickname] = useState(
    settings?.nickname ?? "",
  );
  const [password, setPassword] = useState("");
  const [probe, setProbe] = useState<ServerProbeView | null>(null);
  const [manualFingerprint, setManualFingerprint] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<CoreError | null>(null);
  const [linkError, setLinkError] = useState<InviteLinkError | null>(null);
  const [busy, setBusy] = useState(false);
  const [repaste, setRepaste] = useState(false);

  const parsed = useMemo(
    () => (link.trim().length > 0 ? parseInviteLink(link) : null),
    [link],
  );
  const linkView = parsed?.ok === true ? parsed.link : null;
  const nicknameValid =
    profileNickname.trim().length >= 2 && profileNickname.trim().length <= 32;
  const manual = manualFingerprint.trim();
  const manualValid = /^[0-9a-fA-F]{64}$/.test(manual);
  const manualInvalid = manual !== "" && !manualValid;
  const pinnedNeedsTrust =
    probe?.mode === "pinned" &&
    (probe.certificateChanged || probe.knownFingerprint === null);
  const effectiveFingerprint = manualValid
    ? manual
    : probe?.mode === "pinned"
      ? probe.fingerprint
      : null;
  const directReady =
    manualValid ||
    (probe !== null && (probe.mode === "webPki" || !pinnedNeedsTrust || trusted));
  const testing = voiceState?.micTest === true;
  const available = (devices?.inputs.length ?? 0) > 0;
  const testingActive = testing || selfSpeaking || levelDb > -45;

  // The engine opens the microphone for the whole process; the wizard only
  // starts the loopback on the last step and stops it when it goes away.
  useEffect(() => {
    if (step !== "microphone") {
      return;
    }
    void useVoiceStore.getState().refresh();
    return () => {
      void coreApi.setVoiceMicTest(false).catch(() => {});
    };
  }, [step]);

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length > 0) {
        setLink(text.trim());
      }
    } catch {
      // Clipboard permission may be denied; the field stays editable.
      setRepaste(true);
    }
  }

  function stepIndex(step: Step): number {
    return steps.indexOf(step);
  }

  function nextFromLink() {
    if (mode === "link") {
      if (!parsed || !parsed.ok) {
        setLinkError(parsed && !parsed.ok ? parsed.error : "invalidLink");
        return;
      }
    } else if (address.trim() === "" || !directReady) {
      // The button stays disabled with a reason next to it; never advance
      // silently with an unverified address.
      return;
    }
    setLinkError(null);
    setError(null);
    setStep(steps.includes("nickname") ? "nickname" : "microphone");
  }

  function nextFromNickname() {
    if (!nicknameValid) {
      setError(null);
      return;
    }
    setError(null);
    setStep("microphone");
  }

  /** Step before `step`, skipping the optional nickname step. */
  function previousStep(): Step {
    switch (step) {
      case "diagnostics":
        return "microphone";
      case "microphone":
        return steps.includes("nickname") ? "nickname" : "link";
      case "nickname":
      case "link":
        return "link";
    }
  }

  function setConsent(consent: "granted" | "denied") {
    void updateSettings({ diagnostics: { consent } });
  }

  async function checkCertificate() {
    if (probing || address.trim() === "") {
      return;
    }
    setProbing(true);
    setError(null);
    setTrusted(false);
    try {
      const found = await coreApi.probeServer(address.trim());
      setProbe(found);
      setAdvanced(false);
    } catch (reason) {
      setProbe(null);
      setError(asCoreError(reason));
    } finally {
      setProbing(false);
    }
  }

  function submitStep() {
    if (step === "link") {
      if (mode === "direct" && !manualValid && probe === null) {
        void checkCertificate();
        return;
      }
      nextFromLink();
      return;
    }
    if (step === "nickname") {
      nextFromNickname();
      return;
    }
    if (step === "microphone") {
      setError(null);
      setStep("diagnostics");
      return;
    }
    void finish();
  }

  async function finish() {
    const nickname = (settings?.nickname?.trim() || profileNickname).trim();
    if (!nicknameValid || busy) {
      return;
    }
    if (mode === "link" && !linkView) {
      return;
    }
    if (mode === "direct" && (address.trim() === "" || !directReady)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const target: ConnectTarget =
        mode === "link"
          ? { mode: "link", link: linkView?.raw ?? link.trim() }
          : {
              mode: "direct",
              host: address.trim(),
              port: 0,
              fingerprint: effectiveFingerprint,
            };
      const state = await coreApi.connect({
        target,
        nickname,
        ...(mode === "direct" && password.length > 0 ? { password } : {}),
        ...(mode === "direct"
          ? {
              acceptNewCertificate: manualValid
                ? true
                : probe?.certificateChanged === true && trusted,
            }
          : {}),
      });
      useCoreStore.getState().snapshot(state);
      const target2 = firstVoiceChannel(
        state,
        settings?.defaultChannelId ?? null,
      );
      if (target2) {
        try {
          await coreApi.joinChannel(target2.id, null);
          await updateSettings({
            nickname,
            defaultChannelId: target2.id,
          });
        } catch (joinError) {
          useCoreStore
            .getState()
            .setActionError(asCoreError(joinError), target2.name);
        }
      } else {
        await updateSettings({ nickname });
      }
      await completeOnboarding(nickname);
      closeWizard();
    } catch (reason) {
      const coreError = asCoreError(reason);
      setError(coreError);
      if (coreError.serverCode === "wrongPassword") {
        // Ask for the password again instead of leaving the user stuck on the
        // last step with a generic failure.
        setStep("link");
        setPassword("");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return null;
  }

  const theme = settings.theme;
  const locale = settings.locale;
  const gate = settings.voice.gate;
  const threshold =
    gate.mode === "voiceActivation"
      ? gate.threshold_db ?? settings.voice.activationThresholdDb ?? -45
      : settings.voice.activationThresholdDb ?? -45;
  const linkReason =
    step !== "link"
      ? null
      : mode === "link"
        ? link.trim() === ""
          ? t("connect.reasonLink")
          : null
        : address.trim() === ""
          ? t("connect.reasonAddress")
          : manualInvalid
            ? t("connect.reasonFingerprint")
            : probing
              ? t("connect.reasonProbing")
              : !manualValid && probe === null
              ? t("connect.reasonProbe")
              : !directReady
                ? t("connect.reasonConfirm")
                : null;
  const nicknameReason =
    step === "nickname" && !nicknameValid ? t("connect.reasonNickname") : null;
  const stepReason = step === "link" ? linkReason : nicknameReason;
  const offerProbe =
    step === "link" &&
    mode === "direct" &&
    !probing &&
    address.trim() !== "" &&
    !manualValid &&
    probe === null;

  return (
    <div
      data-testid="onboarding"
      className="flex h-full items-center justify-center bg-background p-6"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitStep();
        }}
        className="flex w-full max-w-[620px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-panel"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className="flex size-10 items-center justify-center rounded-md bg-accent/15">
            <BrandMark className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-semibold text-foreground">
              {t("onboarding.title")}
            </h1>
            <p className="text-[12px] text-muted">{t("onboarding.subtitle")}</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t("settings.general.theme")}
              aria-pressed={theme === "light"}
              onClick={() =>
                void updateSettings({ theme: theme === "dark" ? "light" : "dark" })
              }
              className="inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-foreground"
            >
              {theme === "dark" ? (
                <Sun className="size-4" aria-hidden />
              ) : (
                <Moon className="size-4" aria-hidden />
              )}
            </button>
            <Segmented<LocalePreference>
              value={locale}
              onChange={(value) => void updateSettings({ locale: value })}
              options={[
                { value: "ru", label: "RU" },
                { value: "en", label: "EN" },
              ]}
            />
          </div>
        </header>

        <ol className="flex items-center gap-2 border-b border-border px-5 py-3">
          {steps.map((item, index) => {
            const current = stepIndex(step);
            const done = index < current;
            return (
              <li
                key={item}
                className="flex flex-1 items-center gap-2"
                aria-current={item === step ? "step" : undefined}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                    done
                      ? "border-success/50 bg-success/15 text-success"
                      : item === step
                        ? "border-accent/60 bg-accent/15 text-accent"
                        : "border-border text-faint",
                  )}
                >
                  {done ? <Check className="size-3.5" aria-hidden /> : index + 1}
                </span>
                <span
                  className={cn(
                    "hidden truncate text-[12px] sm:block",
                    item === step ? "text-foreground" : "text-muted",
                  )}
                >
                  {t(`onboarding.steps.${item}`)}
                </span>
                {index < steps.length - 1 ? (
                  <span aria-hidden className="h-px flex-1 bg-border" />
                ) : null}
              </li>
            );
          })}
        </ol>

        <div className="min-h-[300px] flex-1 px-5 py-4">
          {step === "link" ? (
            <section aria-labelledby="onboarding-link-title" className="space-y-3">
              <div>
                <h2
                  id="onboarding-link-title"
                  className="text-[14px] font-semibold text-foreground"
                >
                  {mode === "link"
                    ? t("onboarding.link.title")
                    : t("onboarding.link.directTitle")}
                </h2>
                <p className="mt-0.5 text-[12px] text-muted">
                  {mode === "link"
                    ? t("onboarding.link.hint")
                    : t("onboarding.link.directHint")}
                </p>
              </div>

              <div
                role="group"
                aria-label={t("connect.method")}
                className="flex h-8 items-center gap-0.5 rounded-sm border border-border bg-background p-0.5"
                data-testid="onboarding-choices"
              >
                <button
                  type="button"
                  aria-pressed={mode === "link"}
                  onClick={() => setMode("link")}
                  data-testid="onboarding-mode-link"
                  className={cn(
                    "flex h-6 flex-1 items-center justify-center gap-1.5 rounded-sm px-2 text-[12px] font-medium",
                    mode === "link"
                      ? "bg-active text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                >
                  <Link2 className="size-3.5" aria-hidden />
                  {t("connect.modeLink")}
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "direct"}
                  onClick={() => setMode("direct")}
                  data-testid="onboarding-mode-direct"
                  className={cn(
                    "flex h-6 flex-1 items-center justify-center gap-1.5 rounded-sm px-2 text-[12px] font-medium",
                    mode === "direct"
                      ? "bg-active text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                >
                  <ServerCog className="size-3.5" aria-hidden />
                  {t("connect.modeDirect")}
                </button>
              </div>

              {mode === "link" ? (
                <>
                  <div className="flex gap-1.5">
                    <Input
                      value={link}
                      onChange={(event) => {
                        setLink(event.target.value);
                        setLinkError(null);
                      }}
                      placeholder="rostalk://join?host=192.168.0.13:7443&fp=…&invite=…"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t("onboarding.link.field")}
                      aria-invalid={linkError !== null}
                      autoFocus
                      data-testid="onboarding-link"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void pasteFromClipboard()}
                    >
                      <ClipboardPaste className="size-3.5" aria-hidden />
                      {t("onboarding.link.paste")}
                    </Button>
                  </div>
                  {linkError ? (
                    <p role="alert" className="text-[12px] text-danger">
                      {t(linkErrorMessage(linkError))}
                    </p>
                  ) : null}
                  {repaste ? (
                    <p className="text-[11px] text-faint">
                      {t("onboarding.link.pasteFailed")}
                    </p>
                  ) : null}

                  {linkView ? (
                    <div
                      data-testid="link-preview"
                      className="space-y-2 rounded-md border border-border bg-raised p-3"
                    >
                      <div className="flex items-center gap-2 text-[12px]">
                        <Link2 className="size-3.5 text-faint" aria-hidden />
                        <span className="text-muted">{t("onboarding.link.server")}</span>
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {linkView.host}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[12px]">
                        <ShieldCheck className="size-3.5 text-faint" aria-hidden />
                        <span className="text-muted">
                          {t("onboarding.link.fingerprint")}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground"
                          title={linkView.fingerprint}
                        >
                          {shortFingerprint(linkView.fingerprint)}
                        </span>
                      </div>
                      {isLoopbackHost(linkView.host) ? (
                        <p className="flex items-start gap-1.5 rounded-sm border border-warning/35 bg-warning/10 px-2 py-1.5 text-[11px] text-foreground">
                          <AlertTriangle
                            className="mt-0.5 size-3.5 shrink-0 text-warning"
                            aria-hidden
                          />
                          {t("onboarding.link.loopback")}
                        </p>
                      ) : null}
                      <p className="text-[11px] leading-snug text-faint">
                        {t("onboarding.link.notRewritten")}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="space-y-2">
                  <label className="block space-y-1">
                    <span className="text-[12px] font-medium text-muted">
                      {t("connect.address")}
                    </span>
                    <Input
                      value={address}
                      onChange={(event) => {
                        setAddress(event.target.value);
                        setProbe(null);
                        setTrusted(false);
                      }}
                      onBlur={() => void checkCertificate()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (probe === null && !manualValid) {
                            void checkCertificate();
                          } else {
                            nextFromLink();
                          }
                        }
                      }}
                      placeholder="192.168.0.13:7443"
                      spellCheck={false}
                      autoComplete="off"
                      data-testid="onboarding-host"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[12px] font-medium text-muted">
                      {t("connect.password")}
                    </span>
                    <Input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="off"
                      placeholder={t("connect.passwordHint")}
                      data-testid="onboarding-password"
                    />
                  </label>
                  <div data-testid="onboarding-certificate-state">
                    {probing ? (
                      <p className="text-[11px] text-muted">
                        {t("connect.probing")}
                      </p>
                    ) : probe ? (
                      <CertificatePanel
                        probe={probe}
                        trusted={trusted}
                        onTrust={() => setTrusted(true)}
                      />
                    ) : (
                      <p className="text-[11px] text-faint">
                        {t("connect.probeHint")}
                      </p>
                    )}
                  </div>
                  <div className="rounded-sm border border-border bg-raised">
                    <button
                      type="button"
                      aria-expanded={advanced}
                      data-testid="onboarding-advanced"
                      onClick={() => setAdvanced((value) => !value)}
                      className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-foreground"
                    >
                      <span className="flex items-center gap-1.5">
                        <Fingerprint className="size-3.5" aria-hidden />
                        {t("connect.advanced")}
                      </span>
                      <span aria-hidden>{advanced ? "−" : "+"}</span>
                    </button>
                    {advanced ? (
                      <div className="space-y-1 border-t border-border px-2.5 py-2">
                        <label className="block space-y-1">
                          <span className="text-[11px] font-medium text-muted">
                            {t("connect.fingerprintOptional")}
                          </span>
                          <Input
                            value={manualFingerprint}
                            onChange={(event) => {
                              setManualFingerprint(event.target.value);
                              setProbe(null);
                              setTrusted(false);
                            }}
                            placeholder="sha256…"
                            autoComplete="off"
                            spellCheck={false}
                            className="font-mono"
                            data-testid="onboarding-fingerprint-input"
                          />
                          <span className="block text-[11px] text-faint">
                            {manual !== "" && !manualValid
                              ? t("connect.fingerprintInvalid")
                              : t("connect.manualHint")}
                          </span>
                        </label>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => openHosting()}
                data-testid="onboarding-own-hosting"
                className="text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline"
              >
                {t("onboarding.link.noLink")}
              </button>
            </section>
          ) : null}

          {step === "nickname" ? (
            <section aria-labelledby="onboarding-nick-title" className="space-y-3">
              <div>
                <h2
                  id="onboarding-nick-title"
                  className="text-[14px] font-semibold text-foreground"
                >
                  {t("onboarding.nickname.title")}
                </h2>
                <p className="mt-0.5 text-[12px] text-muted">
                  {t("onboarding.nickname.hint", {
                    host:
                      mode === "link" ? linkView?.host ?? "" : address.trim(),
                  })}
                </p>
              </div>
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-muted">
                  {t("onboarding.nickname.field")}
                </span>
                <Input
                  autoFocus
                  value={profileNickname}
                  onChange={(event) => setProfileNickname(event.target.value)}
                  maxLength={32}
                  autoComplete="nickname"
                  data-testid="onboarding-nickname"
                  aria-invalid={!nicknameValid && profileNickname.length > 0}
                />
                <span className="block text-[11px] text-faint">
                  {t("onboarding.nickname.length", {
                    count: profileNickname.trim().length,
                  })}
                </span>
              </label>
              <div className="flex items-center gap-2 rounded-md border border-border bg-raised px-3 py-2 text-[12px] text-muted">
                <UserRound className="size-4 text-faint" aria-hidden />
                {t("onboarding.nickname.identityHint")}
              </div>
            </section>
          ) : null}

          {step === "microphone" ? (
            <section aria-labelledby="onboarding-mic-title" className="space-y-3">
              <div>
                <h2
                  id="onboarding-mic-title"
                  className="text-[14px] font-semibold text-foreground"
                >
                  {t("onboarding.mic.title")}
                </h2>
                <p className="mt-0.5 text-[12px] text-muted">
                  {t("onboarding.mic.hint")}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium text-muted">
                    {t("voice.inputDevice")}
                  </span>
                  <Select
                    value={settings.voice.inputDevice ?? "default"}
                    onChange={(event) =>
                      void updateVoice({
                        inputDevice:
                          event.target.value === "default"
                            ? null
                            : event.target.value,
                      })
                    }
                    data-testid="onboarding-input"
                  >
                    <option value="default">{t("voice.systemDefault")}</option>
                    {devices?.inputs.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium text-muted">
                    {t("voice.outputDevice")}
                  </span>
                  <Select
                    value={settings.voice.outputDevice ?? "default"}
                    onChange={(event) =>
                      void updateVoice({
                        outputDevice:
                          event.target.value === "default"
                            ? null
                            : event.target.value,
                      })
                    }
                  >
                    <option value="default">{t("voice.systemDefault")}</option>
                    {devices?.outputs.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>

              <div className="rounded-md border border-border bg-raised p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                    <Mic className="size-4 text-accent" aria-hidden />
                    {t("voice.level")}
                  </span>
                  <span className="tabular-nums text-[11px] text-muted">
                    {Math.round(levelDb)} dB
                  </span>
                </div>
                <LevelMeter
                  className="mt-2"
                  levelDb={levelDb}
                  thresholdDb={threshold}
                  label={t("voice.level")}
                  active={testingActive}
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-faint">
                    {available
                      ? testing
                        ? t("voice.testRunning")
                        : t("voice.testHint")
                      : t("voice.noDevices")}
                  </p>
                  <Button
                    type="button"
                    size="xs"
                    variant={testing ? "secondary" : "outline"}
                    disabled={!available}
                    onClick={() => {
                      void coreApi.setVoiceMicTest(!testing).catch(() => {});
                    }}
                    data-testid="onboarding-mic-test"
                  >
                    <Volume2 className="size-3" aria-hidden />
                    {testing ? t("voice.testStop") : t("voice.testStart")}
                  </Button>
                </div>
                {voiceState?.error ? (
                  <p className="mt-2 text-[11px] text-danger">
                    {t("voice.deviceError")}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2 rounded-md border border-border bg-raised p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] font-medium text-foreground">
                    {t("voice.mode")}
                  </span>
                  <Segmented
                    value={gate.mode}
                    onChange={(mode) =>
                      void updateVoice({
                        activationThresholdDb: threshold,
                        gate:
                          mode === "voiceActivation"
                            ? {
                                mode: "voiceActivation",
                                threshold_db: threshold,
                                hold_ms: 300,
                              }
                            : { mode },
                      })
                    }
                    options={[
                      {
                        value: "pushToTalk",
                        label: t("voice.gate.pushToTalk"),
                      },
                      {
                        value: "voiceActivation",
                        label: t("voice.gate.voiceActivation"),
                      },
                      {
                        value: "continuous",
                        label: t("voice.gate.continuous"),
                      },
                    ]}
                  />
                </div>
                {gate.mode === "voiceActivation" ? (
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-muted">
                      <span>{t("voice.threshold")}</span>
                      <span className="tabular-nums">{threshold} dB</span>
                    </div>
                    <Slider
                      min={-80}
                      max={0}
                      step={1}
                      value={threshold}
                      aria-label={t("voice.threshold")}
                      onChange={(event) =>
                        void updateVoice({
                          activationThresholdDb: Number(event.target.value),
                          gate: {
                            mode: "voiceActivation",
                            threshold_db: Number(event.target.value),
                            hold_ms: gate.hold_ms,
                          },
                        })
                      }
                    />
                  </div>
                ) : null}
                {gate.mode === "pushToTalk" ? (
                  <p className="text-[11px] text-faint">
                    {t("voice.pttHint")}
                  </p>
                ) : null}
              </div>

              <p className="flex items-center gap-1.5 text-[11px] text-faint">
                <Headphones className="size-3.5" aria-hidden />
                {t("onboarding.mic.joinHint")}
              </p>
            </section>
          ) : null}

          {step === "diagnostics" ? (
            <section
              aria-labelledby="onboarding-diagnostics-title"
              className="space-y-3"
            >
              <div>
                <h2
                  id="onboarding-diagnostics-title"
                  className="text-[14px] font-semibold text-foreground"
                >
                  {t("onboarding.diagnostics.title")}
                </h2>
                <p className="mt-0.5 text-[12px] leading-snug text-muted">
                  {t("onboarding.diagnostics.hint")}
                </p>
              </div>

              <div className="space-y-2 rounded-md border border-border bg-raised p-3">
                <p className="flex items-start gap-2 text-[11px] leading-snug text-muted">
                  <ShieldCheck
                    className="mt-0.5 size-4 shrink-0 text-accent"
                    aria-hidden
                  />
                  {t("onboarding.diagnostics.detail")}
                </p>
                <div
                  role="group"
                  aria-label={t("onboarding.diagnostics.title")}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      settings.diagnostics.consent === "granted"
                        ? "secondary"
                        : "outline"
                    }
                    aria-pressed={
                      settings.diagnostics.consent === "granted"
                    }
                    onClick={() => setConsent("granted")}
                    data-testid="onboarding-diagnostics-allow"
                  >
                    <Check className="size-3.5" aria-hidden />
                    {t("onboarding.diagnostics.allow")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      settings.diagnostics.consent === "denied"
                        ? "secondary"
                        : "outline"
                    }
                    aria-pressed={settings.diagnostics.consent === "denied"}
                    onClick={() => setConsent("denied")}
                    data-testid="onboarding-diagnostics-deny"
                  >
                    {t("onboarding.diagnostics.notNow")}
                  </Button>
                </div>
                <p className="text-[11px] leading-snug text-faint">
                  {t("onboarding.diagnostics.changeHint")}
                </p>
              </div>
            </section>
          ) : null}

          {error ? <ErrorNotice className="mt-3" error={error} /> : null}
        </div>

        <footer className="flex flex-col gap-2 border-t border-border px-5 py-3">
          {stepReason ? (
            <div
              className="flex items-center gap-2 text-[11px] text-muted"
              data-testid="onboarding-reason"
            >
              <span className="min-w-0 flex-1">{stepReason}</span>
              {offerProbe ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void checkCertificate()}
                  data-testid="onboarding-probe"
                >
                  <ShieldCheck className="size-3" aria-hidden />
                  {t("connect.probe")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            {step !== "link" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setStep(previousStep())}
                disabled={busy}
              >
                <ArrowLeft className="size-3.5" aria-hidden />
                {t("common.back")}
              </Button>
            ) : null}
            {settings.onboardingComplete ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closeWizard}
                disabled={busy}
              >
                {t("common.cancel")}
              </Button>
            ) : null}
            <span className="ml-auto text-[11px] text-faint">
              {t("onboarding.stepOf", {
                current: stepIndex(step) + 1,
                total: steps.length,
              })}
            </span>
            {step === "link" ? (
              <Button
                type="submit"
                size="sm"
                data-testid="onboarding-next"
                disabled={
                  mode === "link"
                    ? link.trim() === ""
                    : address.trim() === "" || !directReady
                }
              >
                {t("common.next")}
                <ArrowRight className="size-3.5" aria-hidden />
              </Button>
            ) : null}
            {step === "nickname" ? (
              <Button
                type="submit"
                size="sm"
                data-testid="onboarding-next"
                disabled={!nicknameValid}
              >
                {t("common.next")}
                <ArrowRight className="size-3.5" aria-hidden />
              </Button>
            ) : null}
            {step === "microphone" ? (
              <Button
                type="submit"
                size="sm"
                disabled={busy}
                data-testid="onboarding-mic-next"
              >
                {t("common.next")}
                <ArrowRight className="size-3.5" aria-hidden />
              </Button>
            ) : null}
            {step === "diagnostics" ? (
              <Button
                type="submit"
                size="sm"
                disabled={busy || !nicknameValid}
                data-testid="onboarding-finish"
              >
                <Check className="size-3.5" aria-hidden />
                {busy ? t("onboarding.connecting") : t("onboarding.finish")}
              </Button>
            ) : null}
          </div>
        </footer>
      </form>
    </div>
  );
}
