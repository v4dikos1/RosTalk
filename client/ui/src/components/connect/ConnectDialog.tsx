import { Fingerprint, Link2, LogIn, ServerCog, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { CertificatePanel } from "@/components/connect/CertificatePanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { coreApi } from "@/core";
import type { CoreError, ServerProbeView } from "@/core/api";
import { defaultVoiceChannel } from "@/lib/channels";
import { asCoreError, coreErrorText } from "@/lib/coreError";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";
import { useSettingsStore } from "@/store/settingsStore";

type LoginMode = "link" | "direct";

/**
 * Quick connect form for "one more server".
 *
 * Two entry points from ADR 0008. An invite link carries the address and the
 * certificate fingerprint, so the link mode asks for nothing else. A direct
 * address is probed when the field loses focus or Enter is pressed: a DNS name
 * goes through Web PKI and needs no fingerprint, while an IP host is pinned and
 * the first or a changed certificate is shown for confirmation. A manual
 * fingerprint stays available under "Advanced" for servers that print it.
 */
export function ConnectDialog() {
  const open = useAppStore((app) => app.connectOpen);
  if (!open) {
    return null;
  }
  return <ConnectDialogContent />;
}

function ConnectDialogContent() {
  const { t } = useTranslation();
  const close = useAppStore((app) => app.closeConnect);
  const openHosting = useAppStore((app) => app.openHosting);
  const connectLink = useAppStore((app) => app.connectLink);
  const settings = useSettingsStore((store) => store.settings);
  const updateSettings = useSettingsStore((store) => store.update);
  const [mode, setMode] = useState<LoginMode>("link");
  const [link, setLink] = useState(connectLink ?? "");
  const [address, setAddress] = useState("");
  const profileNickname = settings?.nickname?.trim() ?? "";
  const [nickname, setNickname] = useState(profileNickname);
  const [password, setPassword] = useState("");
  const [probe, setProbe] = useState<ServerProbeView | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [manualFingerprint, setManualFingerprint] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CoreError | null>(null);

  function switchMode(next: LoginMode) {
    setMode(next);
    setError(null);
    setProbe(null);
    setTrusted(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || probing) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nicknameValue = profileNickname || nickname.trim();
      const request =
        mode === "link"
          ? {
              target: { mode: "link" as const, link: link.trim() },
              nickname: nicknameValue,
            }
          : {
              target: {
                mode: "direct" as const,
                host: address.trim(),
                port: 0,
                fingerprint: effectiveFingerprint,
              },
              ...(password.length > 0 ? { password } : {}),
              acceptNewCertificate: manualValid
                ? true
                : probe?.certificateChanged === true && trusted,
              nickname: nicknameValue,
            };
      const state = await coreApi.connect(request);
      useSettingsStore.setState({ error: null });
      const target = defaultVoiceChannel(
        state,
        settings?.defaultChannelId ?? null,
      );
      if (
        target &&
        state.users.find((user) => user.id === state.selfUserId)?.channelId === 0
      ) {
        try {
          await coreApi.joinChannel(target.id, null);
        } catch {
          // The server's reason is shown by the notice strip; the session stays.
        }
      }
      if (profileNickname === "" && nickname.trim() !== "") {
        await updateSettings({ nickname: nickname.trim() });
      }
      close();
    } catch (reason) {
      setError(asCoreError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function checkCertificate() {
    const value = address.trim();
    if (probing || value === "") {
      return;
    }
    setProbing(true);
    setError(null);
    setTrusted(false);
    try {
      const found = await coreApi.probeServer(value);
      setProbe(found);
      if (found.mode === "pinned") {
        // The digest and its confirmation are the point of the pinned mode;
        // keep the optional manual field out of the way.
        setAdvanced(false);
      }
    } catch (reason) {
      setProbe(null);
      setError(asCoreError(reason));
    } finally {
      setProbing(false);
    }
  }

  const errorText = error ? coreErrorText(error) : null;
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
  const nicknameNeeded = profileNickname === "" && nickname.trim() === "";
  const submitDisabled =
    busy ||
    probing ||
    nicknameNeeded ||
    (mode === "link"
      ? link.trim() === ""
      : address.trim() === "" || manualInvalid || !directReady);

  const reason = submitDisabled
    ? busy
      ? t("connect.connecting")
      : probing
        ? t("connect.reasonProbing")
        : nicknameNeeded
          ? t("connect.reasonNickname")
          : mode === "link"
            ? t("connect.reasonLink")
            : address.trim() === ""
              ? t("connect.reasonAddress")
              : manualInvalid
                ? t("connect.reasonFingerprint")
                : !manualValid && probe === null
                  ? t("connect.reasonProbe")
                : !directReady
                  ? t("connect.reasonConfirm")
                  : null
    : null;
  const offerProbe =
    mode === "direct" &&
    !probing &&
    address.trim() !== "" &&
    !manualValid &&
    probe === null;

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="w-[min(560px,94vw)]"
        closeLabel={t("common.close")}
        data-testid="connect-dialog"
      >
        <form onSubmit={(event) => void submit(event)}>
          <header className="border-b border-border px-4 py-3 pr-12">
            <DialogTitle className="text-[14px] font-semibold">
              {t("connect.title")}
            </DialogTitle>
            <DialogDescription className="text-[12px] text-muted">
              {t("connect.subtitle")}
            </DialogDescription>
          </header>

          <div className="space-y-3 p-4">
            <div
              role="group"
              aria-label={t("connect.method")}
              className="flex h-8 items-center gap-0.5 rounded-sm border border-border bg-background p-0.5"
            >
              <ModeTab
                active={mode === "link"}
                icon={Link2}
                label={t("connect.modeLink")}
                testId="connect-mode-link"
                onClick={() => switchMode("link")}
              />
              <ModeTab
                active={mode === "direct"}
                icon={ServerCog}
                label={t("connect.modeDirect")}
                testId="connect-mode-direct"
                onClick={() => switchMode("direct")}
              />
            </div>

            {mode === "link" ? (
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-muted">
                  {t("connect.link")}
                </span>
                <Input
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                  placeholder="rostalk://join?host=192.168.0.13:7443&fp=…&invite=…"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="connect-link"
                />
                <span className="block text-[11px] text-faint">
                  {t("connect.linkHint")}
                </span>
              </label>
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
                      // A different address means a different certificate.
                      setProbe(null);
                      setTrusted(false);
                    }}
                    onBlur={() => void checkCertificate()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void checkCertificate();
                      }
                    }}
                    placeholder="192.168.0.13:7443"
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="connect-host"
                  />
                  <span className="block text-[11px] text-faint">
                    {t("connect.addressHint")}
                  </span>
                </label>

                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-muted">
                    {t("connect.password")}
                  </span>
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={t("connect.passwordHint")}
                    autoComplete="off"
                    data-testid="connect-password"
                  />
                  <span className="block text-[11px] text-faint">
                    {t("connect.passwordCaption")}
                  </span>
                </label>

                <div data-testid="connect-certificate-state">
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
                    data-testid="connect-advanced"
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
                    <div className="space-y-2 border-t border-border px-2.5 py-2">
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
                          data-testid="connect-fingerprint-input"
                        />
                        <span className="block text-[11px] text-faint">
                          {manual !== "" && !manualValid
                            ? t("connect.fingerprintInvalid")
                            : t("connect.fingerprintHint")}
                        </span>
                      </label>
                      <p className="text-[11px] leading-snug text-faint">
                        {t("connect.manualHint")}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {profileNickname === "" ? (
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-muted">
                  {t("connect.nickname")}
                </span>
                <Input
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder={t("connect.nicknamePlaceholder")}
                  autoComplete="off"
                  maxLength={32}
                  data-testid="connect-nickname"
                />
              </label>
            ) : (
              <p className="text-[11px] text-faint">
                {t("connect.profileNickname", { name: profileNickname })}
              </p>
            )}

            {errorText ? (
              <p
                role="alert"
                className="rounded-sm border border-danger/35 bg-danger/10 px-2 py-1.5 text-[12px] text-foreground"
                title={errorText.detail}
                data-testid="connect-error"
              >
                {t(errorText.key)}
              </p>
            ) : null}
          </div>

          <footer className="border-t border-border">
            {reason ? (
              <div
                className="flex items-center gap-2 border-b border-border/60 px-4 py-1.5 text-[11px] text-muted"
                data-testid="connect-reason"
              >
                <span className="min-w-0 flex-1">{reason}</span>
                {offerProbe ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void checkCertificate()}
                    data-testid="connect-probe"
                  >
                    <ShieldCheck className="size-3" aria-hidden />
                    {t("connect.probe")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-2 px-4 py-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-auto"
                onClick={() => {
                  close();
                  openHosting();
                }}
                data-testid="connect-own-hosting"
              >
                <ServerCog className="size-3.5" aria-hidden />
                {t("hosting.entry")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={submitDisabled}
                data-testid="connect-submit"
              >
                <LogIn className="size-3.5" aria-hidden />
                {busy ? t("connect.connecting") : t("connect.submit")}
              </Button>
            </div>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModeTab({
  active,
  icon: Icon,
  label,
  testId,
  onClick,
}: {
  active: boolean;
  icon: typeof Link2;
  label: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex h-6 flex-1 items-center justify-center gap-1.5 rounded-sm px-2 text-[12px] font-medium",
        active ? "bg-active text-foreground" : "text-muted hover:text-foreground",
      )}
    >
      <Icon className={cn("size-3.5", active ? "text-accent" : "text-faint")} aria-hidden />
      {label}
    </button>
  );
}
