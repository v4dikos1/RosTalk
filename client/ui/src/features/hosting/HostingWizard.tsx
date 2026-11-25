import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Clipboard,
  Fingerprint,
  KeyRound,
  Lock,
  Network,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import type {
  HostingApi,
  HostingCredentials,
  HostingEvent,
  HostingExistingAction,
  HostingHostKeyView,
  HostingLoginMode,
  HostingOutcomeView,
  HostingPreflightView,
} from "./types";
import { cn } from "@/lib/utils";

type Step = 1 | 2 | 3 | 4;
type AuthMethod = "key" | "password";

/** Human text for one hosting error, with the technical detail on demand. */
function hostingErrorText(
  error: { code: string; message: string } | null,
  t: (key: string) => string,
): string {
  if (!error) {
    return "";
  }
  const key = `hosting.errors.${error.code}`;
  const translated = t(key);
  return translated === key ? error.message : translated;
}

function isMismatch(key: HostingHostKeyView | null) {
  return key?.status === "mismatch";
}

/**
 * Installer warnings arrive as English strings from the core. Known ones get
 * a localised line; the raw text stays in the expandable detail instead of
 * leaking into the Russian interface.
 */
function hostingWarning(
  warning: string,
  t: (key: string) => string,
): { text: string; detail: string | null } {
  if (warning.startsWith("No active ufw or firewalld was found")) {
    return { text: t("hosting.done.warnNoFirewall"), detail: null };
  }
  if (
    warning.startsWith("A firewall command failed:") ||
    warning.startsWith("The firewall command could not run:")
  ) {
    return { text: t("hosting.done.warnFirewallFailed"), detail: warning };
  }
  return { text: t("hosting.done.warnOther"), detail: warning };
}

/**
 * The server installation wizard of `rostalk-server-setup` (P13, ADR 0026;
 * the flow itself is stage 6.1a, ADR 0021). It fills the whole window of the
 * installer and talks only to `api`. The result is a pair of invite links the
 * user copies into the RosTalk client: this program does not connect anywhere
 * itself and opens no browser (ADR 0023).
 */
export function HostingWizard({ api }: { api: HostingApi }) {
  const { t } = useTranslation();

  const [step, setStep] = useState<Step>(1);
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [method, setMethod] = useState<AuthMethod>("key");
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [hostKey, setHostKey] = useState<HostingHostKeyView | null>(null);
  const [trustNew, setTrustNew] = useState(false);
  const [probing, setProbing] = useState(false);

  const [preflight, setPreflight] = useState<HostingPreflightView | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [serverName, setServerName] = useState("RosTalk");
  const [domain, setDomain] = useState("");
  const [publicHost, setPublicHost] = useState("");
  const [advertiseIp, setAdvertiseIp] = useState("");
  const [loginMode, setLoginMode] = useState<HostingLoginMode>("invite");
  const [serverPassword, setServerPassword] = useState("");
  const [maxUsers, setMaxUsers] = useState("50");
  const [openFirewall, setOpenFirewall] = useState(false);
  const [installPackages, setInstallPackages] = useState(true);
  const [existingAction, setExistingAction] =
    useState<HostingExistingAction>("fresh");

  const [bundle, setBundle] = useState<{
    available: boolean;
    version: string | null;
    error: string | null;
  } | null>(null);
  const [savedCreds, setSavedCreds] = useState<{
    key: string;
    hasPassword: boolean;
    hasSudoPassword: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    code: string;
    message: string;
    detail: string | null;
    fingerprint: string | null;
  } | null>(null);

  const [operationId, setOperationId] = useState<string | null>(null);
  const operationRef = useRef<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("connecting");
  const [message, setMessage] = useState("");
  const [journal, setJournal] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<HostingOutcomeView | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void api.hostingBundleStatus().then(setBundle).catch(() => {});
  }, [api]);

  useEffect(() => {
    const unsubscribe = api.subscribeHosting((event: HostingEvent) => {
      if (operationRef.current === null) {
        operationRef.current = event.operationId;
        setOperationId(event.operationId);
      }
      if (event.operationId !== operationRef.current) {
        return;
      }
      setStage(event.stage);
      setProgress(event.percent);
      setMessage(event.message);
      if (event.detail) {
        setJournal((current) => [...current.slice(-200), event.detail!]);
      }
      if (event.finished) {
        if (event.outcome) {
          setOutcome(event.outcome);
          setStep(4);
        }
        if (event.error) {
          setError(event.error);
        }
      }
    });
    return unsubscribe;
  }, [api]);

  // Remembered credentials are only reported as available, never filled in.
  useEffect(() => {
    if (address.trim() === "" || username.trim() === "") {
      return;
    }
    let cancelled = false;
    const key = `${address.trim()}|${username.trim()}`;
    void api
      .hostingLoadCredentials(address.trim(), username.trim())
      .then((saved) => {
        if (!cancelled) {
          setSavedCreds({ key, ...saved });
        }
      })
      .catch(() => {
        // A missing keychain entry is not an error.
      });
    return () => {
      cancelled = true;
    };
  }, [api, method, address, username]);

  const credentials = useMemo<HostingCredentials>(
    () => ({
      method,
      host: address.trim(),
      port: Number.parseInt(port, 10) || 22,
      username: username.trim(),
      keyPath: method === "key" ? keyPath.trim() || null : null,
      keyPassphrase: method === "key" ? passphrase || null : null,
      password: method === "password" ? password || null : null,
      sudoPassword: sudoPassword || null,
    }),
    [method, address, port, username, keyPath, passphrase, password, sudoPassword],
  );

  const savedAvailable =
    savedCreds !== null &&
    savedCreds.key === `${address.trim()}|${username.trim()}` &&
    (savedCreds.hasPassword || savedCreds.hasSudoPassword);
  const savedPasswordAvailable =
    savedAvailable && savedCreds.hasPassword && password === "";
  const savedSudoAvailable =
    savedAvailable && savedCreds.hasSudoPassword && sudoPassword === "";

  const accessReady =
    address.trim() !== "" &&
    username.trim() !== "" &&
    (method === "key"
      ? keyPath.trim() !== ""
      : password !== "" || savedPasswordAvailable);
  const hostReady =
    hostKey !== null &&
    !isMismatch(hostKey) &&
    (hostKey.status !== "new" || trustNew);

  function resetHostKey() {
    setHostKey(null);
    setTrustNew(false);
    setPreflight(null);
    setError(null);
  }

  async function checkHostKey() {
    if (!accessReady || probing) {
      return;
    }
    setProbing(true);
    setError(null);
    setHostKey(null);
    try {
      setHostKey(
        await api.hostingProbe({
          host: address.trim(),
          port: Number.parseInt(port, 10) || 22,
          username: username.trim(),
        }),
      );
    } catch (reason) {
      setError(reason as typeof error);
    } finally {
      setProbing(false);
    }
  }

  async function pickKey() {
    const picked = await api.hostingPickKey();
    if (picked) {
      setKeyPath(picked);
      resetHostKey();
    }
  }

  async function loadPreflight() {
    setPreflighting(true);
    setError(null);
    try {
      const report = await api.hostingPreflight({
        credentials,
        expectedHostKey: hostKey?.fingerprint ?? null,
        trustHostKey: true,
        domain: domain.trim() || null,
      });
      setPreflight(report);
      if (publicHost.trim() === "") {
        setPublicHost(address.trim());
      }
      if (report.existing) {
        setExistingAction(
          report.existing.adminInvitePending ? "reinstall" : "update",
        );
      }
    } catch (reason) {
      setError(reason as typeof error);
      setStep(1);
    } finally {
      setPreflighting(false);
    }
  }

  async function nextFromServer() {
    if (!hostReady) {
      return;
    }
    setStep(2);
    await loadPreflight();
  }

  async function startInstall() {
    if (!preflight || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setOutcome(null);
    setJournal([]);
    setProgress(0);
    setStage("connecting");
    setMessage(t("hosting.install.starting"));
    setStep(3);
    try {
      const id = await api.hostingInstallStart({
        credentials,
        expectedHostKey: hostKey?.fingerprint ?? null,
        trustHostKey: true,
        serverName: serverName.trim() || null,
        domain: domain.trim() || null,
        publicHost: publicHost.trim(),
        advertiseIp: advertiseIp.trim() || null,
        loginMode,
        serverPassword: loginMode === "password" ? serverPassword : null,
        maxUsers: Number.parseInt(maxUsers, 10) || null,
        openFirewall,
        installPackages,
        existingAction,
        rememberPassword: remember,
      });
      operationRef.current = id;
      setOperationId(id);
    } catch (reason) {
      setError(reason as typeof error);
      setStep(2);
    } finally {
      setBusy(false);
    }
  }

  async function cancelInstall() {
    if (operationId) {
      await api.hostingCancel(operationId).catch(() => {});
    }
  }

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // Clipboard permission may be denied; the link stays selectable.
    }
  }

  const errorText = error
    ? hostingErrorText(error, t)
    : t("hosting.errors.internal");
  const stepLabels = [
    t("hosting.steps.server"),
    t("hosting.steps.check"),
    t("hosting.steps.install"),
    t("hosting.steps.done"),
  ];

  return (
    <main
      className="mx-auto flex h-full w-full max-w-[860px] flex-col bg-surface"
      data-testid="hosting-wizard"
    >
        <header className="border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <ServerCog className="size-4 text-accent" aria-hidden />
            <h1 className="text-[14px] font-semibold">
              {t("hosting.title")}
            </h1>
          </div>
          <p className="text-[12px] text-muted">
            {t("hosting.subtitle")}
          </p>
          <ol className="mt-3 flex items-center gap-2" data-testid="hosting-steps">
            {stepLabels.map((label, index) => {
              const number = (index + 1) as Step;
              const done = number < step;
              return (
                <li key={label} className="flex flex-1 items-center gap-2">
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                      done
                        ? "border-success/50 bg-success/15 text-success"
                        : number === step
                          ? "border-accent/60 bg-accent/15 text-accent"
                          : "border-border text-faint",
                    )}
                  >
                    {done ? <Check className="size-3" aria-hidden /> : number}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[11px]",
                      number === step ? "text-foreground" : "text-muted",
                    )}
                  >
                    {label}
                  </span>
                  {index < stepLabels.length - 1 ? (
                    <span aria-hidden className="h-px flex-1 bg-border" />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </header>

        <div className="min-h-[340px] flex-1 overflow-y-auto px-5 py-4">
          {step === 1 ? (
            <section className="space-y-3" data-testid="hosting-step-server">
              <p className="text-[12px] text-muted">{t("hosting.server.hint")}</p>
              <div className="grid grid-cols-[1fr_92px] gap-2">
                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-muted">
                    {t("hosting.server.address")}
                  </span>
                  <Input
                    value={address}
                    onChange={(event) => {
                      setAddress(event.target.value);
                      resetHostKey();
                    }}
                    placeholder="203.0.113.5"
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="hosting-address"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-muted">
                    {t("hosting.server.port")}
                  </span>
                  <Input
                    value={port}
                    onChange={(event) => {
                      setPort(event.target.value);
                      resetHostKey();
                    }}
                    inputMode="numeric"
                    autoComplete="off"
                    data-testid="hosting-port"
                  />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-muted">
                  {t("hosting.server.user")}
                </span>
                <Input
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    resetHostKey();
                  }}
                  placeholder="root"
                  autoComplete="username"
                  spellCheck={false}
                  data-testid="hosting-user"
                />
                <span className="block text-[11px] text-faint">
                  {t("hosting.server.userHint")}
                </span>
              </label>

              <Segmented<AuthMethod>
                value={method}
                onChange={(value) => {
                  setMethod(value);
                  resetHostKey();
                }}
                label={t("hosting.server.method")}
                options={[
                  { value: "key", label: t("hosting.server.methodKey"), icon: KeyRound },
                  { value: "password", label: t("hosting.server.methodPassword"), icon: Lock },
                ]}
              />

              {method === "key" ? (
                <div className="space-y-2">
                  <label className="block space-y-1">
                    <span className="text-[12px] font-medium text-muted">
                      {t("hosting.server.key")}
                    </span>
                    <div className="flex gap-1.5">
                      <Input
                        value={keyPath}
                        onChange={(event) => {
                          setKeyPath(event.target.value);
                          resetHostKey();
                        }}
                        placeholder="C:\Users\me\.ssh\id_ed25519"
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono text-[11px]"
                        data-testid="hosting-key"
                      />
                      <Button type="button" size="sm" variant="secondary" onClick={() => void pickKey()}>
                        {t("hosting.server.browse")}
                      </Button>
                    </div>
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-medium text-muted">
                      {t("hosting.server.passphrase")}
                    </span>
                    <Input
                      type="password"
                      value={passphrase}
                      onChange={(event) => {
                        setPassphrase(event.target.value);
                        resetHostKey();
                      }}
                      placeholder={t("hosting.server.passphraseHint")}
                      autoComplete="off"
                      data-testid="hosting-passphrase"
                    />
                  </label>
                </div>
              ) : (
                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-muted">
                    {t("hosting.server.password")}
                  </span>
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      resetHostKey();
                    }}
                    placeholder={t("hosting.server.passwordHint")}
                    autoComplete="off"
                    data-testid="hosting-password"
                  />
                  {savedPasswordAvailable ? (
                    <span
                      className="block text-[11px] text-accent"
                      data-testid="hosting-saved-password"
                    >
                      {t("hosting.server.savedPassword")}
                    </span>
                  ) : null}
                </label>
              )}

              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-muted">
                  {t("hosting.server.sudo")}
                </span>
                <Input
                  type="password"
                  value={sudoPassword}
                  onChange={(event) => {
                    setSudoPassword(event.target.value);
                    resetHostKey();
                  }}
                  placeholder={t("hosting.server.sudoHint")}
                  autoComplete="off"
                  data-testid="hosting-sudo"
                />
                {savedSudoAvailable ? (
                  <span
                    className="block text-[11px] text-accent"
                    data-testid="hosting-saved-sudo"
                  >
                    {t("hosting.server.savedSudo")}
                  </span>
                ) : null}
              </label>

              <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-raised px-2.5 py-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!accessReady || probing}
                  onClick={() => void checkHostKey()}
                  data-testid="hosting-check-host"
                >
                  <Fingerprint className="size-3.5" aria-hidden />
                  {probing ? t("hosting.server.checking") : t("hosting.server.check")}
                </Button>
                <span className="text-[11px] text-faint">
                  {t("hosting.server.checkHint")}
                </span>
              </div>

              {hostKey ? (
                <div
                  className={cn(
                    "space-y-1.5 rounded-sm border px-2.5 py-2",
                    hostKey.status === "mismatch"
                      ? "border-danger/45 bg-danger/10"
                      : hostKey.status === "new"
                        ? "border-warning/40 bg-warning/10"
                        : "border-success/35 bg-success/10",
                  )}
                  data-testid="hosting-host-key"
                >
                  <p className="flex items-center gap-1.5 text-[12px] font-medium">
                    {hostKey.status === "mismatch" ? (
                      <AlertTriangle className="size-3.5 text-danger" aria-hidden />
                    ) : (
                      <ShieldCheck className="size-3.5 text-success" aria-hidden />
                    )}
                    {hostKey.status === "known"
                      ? t("hosting.server.keyKnown")
                      : hostKey.status === "new"
                        ? t("hosting.server.keyNew")
                        : t("hosting.server.keyMismatch")}
                  </p>
                  <p className="break-all font-mono text-[11px] text-foreground">
                    {hostKey.algorithm} SHA256:{hostKey.fingerprint}
                  </p>
                  {hostKey.status === "mismatch" ? (
                    <p className="text-[11px] leading-snug text-foreground">
                      {t("hosting.server.mismatchHint", {
                        saved: hostKey.savedFingerprint ?? "—",
                      })}
                    </p>
                  ) : hostKey.status === "new" ? (
                    <label className="flex items-start gap-2 text-[11px] text-foreground">
                      <input
                        type="checkbox"
                        checked={trustNew}
                        onChange={(event) => setTrustNew(event.target.checked)}
                        data-testid="hosting-trust"
                      />
                      {t("hosting.server.trustNew")}
                    </label>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {step === 2 ? (
            <section className="space-y-3" data-testid="hosting-step-check">
              {preflighting ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-raised px-3 py-3 text-[12px] text-muted">
                  <RefreshCw className="size-4 animate-spin" aria-hidden />
                  {t("hosting.check.running")}
                </div>
              ) : preflight ? (
                <>
                  <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-raised px-3 py-2 text-[12px]">
                    <Summary label={t("hosting.check.os")} value={`${preflight.osName} ${preflight.osVersion}`} />
                    <Summary label={t("hosting.check.arch")} value={preflight.kernelArch} />
                    <Summary label={t("hosting.check.systemd")} value={preflight.systemd ? preflight.systemdVersion ?? "systemd" : t("hosting.check.no")} />
                    <Summary label={t("hosting.check.disk")} value={`${preflight.freeDiskMb} MB`} />
                    <Summary label={t("hosting.check.tools")} value={[preflight.hasTar ? "tar" : "tar ✕", preflight.hasSha256sum ? "sha256sum" : "sha256sum ✕", preflight.hasOpenssl ? "openssl" : "openssl ✕"].join(" · ")} />
                    <Summary label={t("hosting.check.firewall")} value={preflight.firewall} />
                  </div>

                  {preflight.problems.length > 0 ? (
                    <div className="space-y-1 rounded-sm border border-warning/40 bg-warning/10 px-2.5 py-2">
                      {preflight.problems.map((problem, index) => (
                        <p key={`${problem.code}-${index}`} className="flex items-start gap-1.5 text-[11px] text-foreground">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                          {problem.message}
                        </p>
                      ))}
                    </div>
                  ) : null}

                  {preflight.hasOpenssl && !preflight.opensslRawin ? (
                    <p className="flex items-start gap-1.5 rounded-sm border border-warning/35 bg-warning/10 px-2.5 py-2 text-[11px] text-foreground" data-testid="hosting-openssl-warning">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                      {t("hosting.check.opensslOld", {
                        version: preflight.opensslVersion ?? "OpenSSL 1.1.1",
                      })}
                    </p>
                  ) : null}

                  {preflight.missingPackages.length > 0 ? (
                    <label className="flex items-start gap-2 rounded-sm border border-border bg-raised px-2.5 py-2 text-[11px]">
                      <input
                        type="checkbox"
                        checked={installPackages}
                        onChange={(event) => setInstallPackages(event.target.checked)}
                        data-testid="hosting-install-packages"
                      />
                      {t("hosting.check.installPackages", {
                        packages: preflight.missingPackages.join(", "),
                      })}
                    </label>
                  ) : null}

                  {preflight.existing ? (
                    <div className="space-y-2 rounded-md border border-border bg-raised px-3 py-2">
                      <p className="text-[12px] font-medium text-foreground">
                        {t("hosting.check.existing", {
                          version: preflight.existing.version ?? "—",
                        })}
                      </p>
                      <Segmented<HostingExistingAction>
                        value={existingAction}
                        onChange={setExistingAction}
                        options={[
                          { value: "update", label: t("hosting.check.update") },
                          { value: "reinstall", label: t("hosting.check.reinstall") },
                        ]}
                      />
                      {existingAction === "reinstall" ? (
                        <p className="text-[11px] text-faint">
                          {t("hosting.check.reinstallHint")}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block space-y-1">
                      <span className="text-[12px] font-medium text-muted">
                        {t("hosting.check.serverName")}
                      </span>
                      <Input
                        value={serverName}
                        onChange={(event) => setServerName(event.target.value)}
                        maxLength={64}
                        data-testid="hosting-server-name"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[12px] font-medium text-muted">
                        {t("hosting.check.maxUsers")}
                      </span>
                      <Input
                        value={maxUsers}
                        onChange={(event) => setMaxUsers(event.target.value)}
                        inputMode="numeric"
                        data-testid="hosting-max-users"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[12px] font-medium text-muted">
                        {t("hosting.check.domain")}
                      </span>
                      <Input
                        value={domain}
                        onChange={(event) => setDomain(event.target.value)}
                        placeholder="rostalk.example.com"
                        autoComplete="off"
                        spellCheck={false}
                        data-testid="hosting-domain"
                      />
                      <span className="block text-[10px] text-faint">
                        {t("hosting.check.domainHint")}
                      </span>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[12px] font-medium text-muted">
                        {t("hosting.check.publicHost")}
                      </span>
                      <Input
                        value={publicHost}
                        onChange={(event) => setPublicHost(event.target.value)}
                        placeholder="203.0.113.5"
                        autoComplete="off"
                        spellCheck={false}
                        data-testid="hosting-public-host"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[12px] font-medium text-muted">
                        {t("hosting.check.advertiseIp")}
                      </span>
                      <Input
                        value={advertiseIp}
                        onChange={(event) => setAdvertiseIp(event.target.value)}
                        placeholder={t("hosting.check.advertiseHint")}
                        autoComplete="off"
                        spellCheck={false}
                        data-testid="hosting-advertise-ip"
                      />
                    </label>
                    <div className="block space-y-1">
                      <span className="text-[12px] font-medium text-muted">
                        {t("hosting.check.loginMode")}
                      </span>
                      <Segmented<HostingLoginMode>
                        value={loginMode}
                        onChange={setLoginMode}
                        options={[
                          { value: "invite", label: t("hosting.check.loginInvite") },
                          { value: "password", label: t("hosting.check.loginPassword") },
                          { value: "open", label: t("hosting.check.loginOpen") },
                        ]}
                      />
                    </div>
                  </div>

                  {loginMode === "password" ? (
                    <label className="block space-y-1">
                      <span className="text-[12px] font-medium text-muted">
                        {t("hosting.check.serverPassword")}
                      </span>
                      <Input
                        type="password"
                        value={serverPassword}
                        onChange={(event) => setServerPassword(event.target.value)}
                        autoComplete="new-password"
                        data-testid="hosting-server-password"
                      />
                    </label>
                  ) : null}

                  <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-raised px-3 py-2">
                    <label className="flex items-center justify-between gap-2 text-[11px]">
                      <span>{t("hosting.check.openFirewall")}</span>
                      <Switch
                        checked={openFirewall}
                        onCheckedChange={setOpenFirewall}
                        data-testid="hosting-open-firewall"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-[11px]">
                      <span>{t("hosting.check.remember")}</span>
                      <Switch
                        checked={remember}
                        onCheckedChange={setRemember}
                        data-testid="hosting-remember"
                      />
                    </label>
                    <p className="col-span-2 text-[10px] leading-snug text-faint">
                      {t("hosting.check.firewallHint")}
                    </p>
                  </div>

                  {bundle && !bundle.available ? (
                    <p className="rounded-sm border border-danger/40 bg-danger/10 px-2.5 py-2 text-[11px] text-foreground">
                      {t("hosting.check.bundleMissing")}
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="space-y-2">
                  <p className="text-[12px] text-muted">{t("hosting.check.failed")}</p>
                  <Button type="button" size="sm" variant="secondary" onClick={() => void loadPreflight()}>
                    <RefreshCw className="size-3.5" aria-hidden />
                    {t("hosting.check.retry")}
                  </Button>
                </div>
              )}
            </section>
          ) : null}

          {step === 3 ? (
            <section className="space-y-3" data-testid="hosting-step-install">
              <div className="rounded-md border border-border bg-raised px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12px] font-medium text-foreground">
                    {t(`hosting.stages.${stage}`)}
                  </p>
                  <span className="tabular-nums text-[11px] text-muted">{progress}%</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
                  <div
                    className="h-full origin-left rounded-full bg-accent transition-transform duration-150"
                    style={{ transform: `scaleX(${progress / 100})` }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-muted">{message}</p>
              </div>
              {journal.length > 0 ? (
                <details className="rounded-md border border-border bg-background" data-testid="hosting-journal">
                  <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-muted">
                    <Terminal className="size-3.5" aria-hidden />
                    {t("hosting.install.journal")}
                  </summary>
                  <pre className="max-h-36 overflow-auto whitespace-pre-wrap px-3 pb-2 font-mono text-[10px] text-faint">
                    {journal.join("\n")}
                  </pre>
                </details>
              ) : null}
              {error ? (
                <div
                  role="alert"
                  className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2"
                  data-testid="hosting-error"
                >
                  <p className="text-[12px] font-medium text-foreground">{errorText}</p>
                  {error.detail ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-muted">
                        {t("hosting.install.details")}
                      </summary>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-faint">
                        {error.detail}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {step === 4 && outcome ? (
            <section className="space-y-3" data-testid="hosting-step-done">
              <div className="flex items-center gap-2 rounded-md border border-success/35 bg-success/10 px-3 py-2">
                <ShieldCheck className="size-4 text-success" aria-hidden />
                <p className="text-[12px] font-medium text-foreground">
                  {t("hosting.done.title")} · {outcome.serverVersion}
                </p>
              </div>

              {outcome.warnings.length > 0 ? (
                <div className="space-y-1 rounded-sm border border-warning/40 bg-warning/10 px-2.5 py-2" data-testid="hosting-warnings">
                  {outcome.warnings.map((warning, index) => {
                    const mapped = hostingWarning(warning, t);
                    return (
                      <div key={index} className="text-[11px] text-foreground">
                        <p className="flex items-start gap-1.5">
                          <AlertTriangle
                            className="mt-0.5 size-3.5 shrink-0 text-warning"
                            aria-hidden
                          />
                          {mapped.text}
                        </p>
                        {mapped.detail ? (
                          <details className="ml-5 mt-0.5">
                            <summary className="cursor-pointer text-[10px] text-muted">
                              {t("hosting.install.details")}
                            </summary>
                            <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-faint">
                              {mapped.detail}
                            </pre>
                          </details>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {outcome.adminLink ? (
                <div className="space-y-1.5">
                  <p className="text-[12px] font-medium text-foreground">
                    {t("hosting.done.adminTitle")}
                  </p>
                  <div className="flex gap-1.5">
                    <Input
                      readOnly
                      value={outcome.adminLink}
                      className="font-mono text-[11px]"
                      data-testid="hosting-admin-link"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={t("hosting.done.copyAdmin")}
                      onClick={() => void copy(outcome.adminLink!, "admin")}
                    >
                      {copied === "admin" ? <Check className="size-3.5" aria-hidden /> : <Clipboard className="size-3.5" aria-hidden />}
                    </Button>
                  </div>
                  <p className="text-[11px] text-faint">
                    {t("hosting.done.adminHint")}
                  </p>
                </div>
              ) : (
                <p className="rounded-sm border border-border bg-raised px-2.5 py-2 text-[11px] text-muted">
                  {t("hosting.done.noAdmin")}
                </p>
              )}

              {outcome.memberLink ? (
                <div className="space-y-1.5">
                  <p className="text-[12px] font-medium text-foreground">
                    {t("hosting.done.memberTitle")}
                  </p>
                  <div className="flex gap-1.5">
                    <Input
                      readOnly
                      value={outcome.memberLink}
                      className="font-mono text-[11px]"
                      data-testid="hosting-member-link"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={t("hosting.done.copyMember")}
                      onClick={() => void copy(outcome.memberLink!, "member")}
                    >
                      {copied === "member" ? <Check className="size-3.5" aria-hidden /> : <Clipboard className="size-3.5" aria-hidden />}
                    </Button>
                  </div>
                  <p className="text-[11px] text-faint">
                    {t("hosting.done.memberHint")}
                  </p>
                  {loginMode === "password" ? (
                    <p className="text-[11px] text-warning">
                      {t("hosting.done.passwordHint")}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {outcome.backupPath ? (
                <p className="text-[11px] text-faint">
                  {t("hosting.done.backup", { path: outcome.backupPath })}
                </p>
              ) : null}

              <div className="space-y-1 rounded-md border border-border bg-raised px-3 py-2">
                <p className="flex items-center gap-1.5 text-[12px] font-medium">
                  <Network className="size-3.5 text-warning" aria-hidden />
                  {t("hosting.done.portsTitle")}
                </p>
                <p className="text-[11px] leading-snug text-muted">
                  {outcome.firewallApplied
                    ? t("hosting.done.portsApplied")
                    : t("hosting.done.portsManual")}
                </p>
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-faint">
                  {outcome.firewallCommands.join("\n")}
                </pre>
                <p className="text-[11px] leading-snug text-foreground">
                  {t("hosting.done.cloudFirewall")}
                </p>
              </div>

              {error ? (
                <div role="alert" className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-[12px]">
                  {errorText}
                </div>
              ) : null}
            </section>
          ) : null}

          {error && step !== 3 ? (
            <p
              role="alert"
              className="mt-3 rounded-sm border border-danger/35 bg-danger/10 px-2.5 py-2 text-[12px] text-foreground"
              title={error.detail ?? undefined}
              data-testid="hosting-inline-error"
            >
              {errorText}
              {error.fingerprint ? (
                <span className="mt-1 block break-all font-mono text-[10px] text-danger">
                  SHA256:{error.fingerprint}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
          {step === 2 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep(1)} disabled={preflighting}>
              <ArrowLeft className="size-3.5" aria-hidden />
              {t("common.back")}
            </Button>
          ) : null}
          {step === 3 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void cancelInstall()}
              data-testid="hosting-cancel"
            >
              <X className="size-3.5" aria-hidden />
              {t("hosting.install.cancel")}
            </Button>
          ) : null}
          <span className="ml-auto text-[11px] text-faint">
            {t("hosting.stepOf", { current: step, total: 4 })}
          </span>
          {step === 1 ? (
            <Button
              type="button"
              size="sm"
              disabled={!hostReady || probing}
              onClick={() => void nextFromServer()}
              data-testid="hosting-next"
            >
              {t("common.next")}
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          {step === 2 ? (
            preflight && preflight.supported ? (
              <Button
                type="button"
                size="sm"
                disabled={
                  busy ||
                  preflighting ||
                  (loginMode === "password" && serverPassword.length < 4) ||
                  (bundle !== null && !bundle.available)
                }
                onClick={() => void startInstall()}
                data-testid="hosting-install"
              >
                <ServerCog className="size-3.5" aria-hidden />
                {t("hosting.check.install")}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="secondary" onClick={() => void loadPreflight()} disabled={preflighting}>
                <RefreshCw className="size-3.5" aria-hidden />
                {t("hosting.check.retry")}
              </Button>
            )
          ) : null}
        </footer>
    </main>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <p className="min-w-0">
      <span className="block text-[11px] font-medium text-faint">{label}</span>
      <span className="block truncate text-[12px] text-foreground" title={value}>
        {value}
      </span>
    </p>
  );
}
