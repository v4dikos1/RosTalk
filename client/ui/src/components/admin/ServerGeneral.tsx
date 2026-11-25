/* eslint-disable react-hooks/set-state-in-effect -- data screens synchronise with the core through async requests */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { LoginModeView, ServerView } from "@/core/api";
import { serverSettingsSet } from "@/lib/admin";

import { AdminCard, AdminErrorNotice, AdminPending, useAdminAction } from "./AdminCommon";

export function ServerGeneral({
  server,
  canManageServer,
}: {
  server: ServerView | null;
  canManageServer: boolean;
}) {
  const { t } = useTranslation();
  const action = useAdminAction();
  const [name, setName] = useState(server?.name ?? "");
  const [loginMode, setLoginMode] = useState<LoginModeView>(server?.loginMode ?? "invite");
  const [maxUsers, setMaxUsers] = useState(server?.maxUsers ?? 0);
  const [maxAttachmentMiB, setMaxAttachmentMiB] = useState(
    Math.round((server?.maxAttachmentBytes ?? 25 * 1024 * 1024) / (1024 * 1024)),
  );
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const attachmentLimitValid =
    Number.isFinite(maxAttachmentMiB) && maxAttachmentMiB >= 1 && maxAttachmentMiB <= 2048;

  useEffect(() => {
    if (server) {
      setName(server.name);
      setLoginMode(server.loginMode);
      setMaxUsers(server.maxUsers);
      setMaxAttachmentMiB(Math.round(server.maxAttachmentBytes / (1024 * 1024)));
    }
  }, [
    server?.name,
    server?.loginMode,
    server?.maxUsers,
    server?.maxAttachmentBytes,
    server,
  ]);

  if (!canManageServer) {
    return (
      <AdminCard title={t("admin.general.title")} hint={t("admin.general.noRight")}>
        <p className="py-3 text-[11px] text-faint">{t("admin.general.noRightHint")}</p>
      </AdminCard>
    );
  }

  async function save() {
    const result = await action.run(
      serverSettingsSet({
        name: name.trim(),
        loginMode,
        maxUsers,
        maxAttachmentBytes: Math.round(maxAttachmentMiB * 1024 * 1024),
        password: clearPassword ? "" : password === "" ? undefined : password,
      }),
    );
    if (result) {
      setPassword("");
      setClearPassword(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="server-general">
      <AdminCard title={t("admin.general.title")} hint={t("admin.general.hint")}>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.general.name")}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={64}
              data-testid="server-name"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.general.loginMode")}</span>
            <Select
              value={loginMode}
              onChange={(event) => setLoginMode(event.target.value as LoginModeView)}
              data-testid="server-login-mode"
            >
              <option value="invite">{t("admin.general.modeInvite")}</option>
              <option value="password">{t("admin.general.modePassword")}</option>
              <option value="open">{t("admin.general.modeOpen")}</option>
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.general.maxUsers")}</span>
            <Input
              type="number"
              min={0}
              value={maxUsers}
              onChange={(event) => setMaxUsers(Math.max(0, Number(event.target.value) || 0))}
              data-testid="server-max-users"
            />
            <span className="block text-[10px] text-faint">{t("admin.general.maxUsersHint")}</span>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">
              {t("admin.general.maxAttachment")}
            </span>
            <Input
              type="number"
              min={1}
              max={2048}
              value={maxAttachmentMiB}
              onChange={(event) =>
                setMaxAttachmentMiB(
                  Math.max(1, Math.min(2048, Number(event.target.value) || 1)),
                )
              }
              data-testid="server-max-attachment"
            />
            <span className="block text-[10px] text-faint">
              {t("admin.general.maxAttachmentHint")}
            </span>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">{t("admin.general.password")}</span>
            <Input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setClearPassword(false);
              }}
              placeholder={
                server?.passwordSet
                  ? t("admin.general.passwordSet")
                  : t("admin.general.passwordNone")
              }
              autoComplete="new-password"
              data-testid="server-password"
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {server?.passwordSet ? (
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={clearPassword}
                onChange={(event) => {
                  setClearPassword(event.target.checked);
                  if (event.target.checked) {
                    setPassword("");
                  }
                }}
              />
              {t("admin.general.clearPassword")}
            </label>
          ) : null}
          <Button
            size="sm"
            className="ml-auto"
            disabled={
              action.pending || name.trim() === "" || !attachmentLimitValid
            }
            onClick={() => void save()}
            data-testid="server-save"
          >
            {t("common.save")}
          </Button>
          <AdminPending pending={action.pending} />
        </div>
        <AdminErrorNotice error={action.error} />
      </AdminCard>

      <AdminCard title={t("admin.general.factsTitle")} hint={t("admin.general.factsHint")}>
        <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-muted">{t("admin.general.version")}</dt>
          <dd className="text-foreground">{server?.version ?? "—"}</dd>
          <dt className="text-muted">{t("admin.general.protocol")}</dt>
          <dd className="text-foreground">v{server?.protocolVersion ?? "—"}</dd>
          <dt className="text-muted">{t("admin.general.online")}</dt>
          <dd className="text-foreground">
            {server ? `${server.onlineUsers} / ${server.maxUsers === 0 ? "∞" : server.maxUsers}` : "—"}
          </dd>
          <dt className="text-muted">{t("admin.general.passwordState")}</dt>
          <dd className="text-foreground">
            {server?.passwordSet ? t("admin.general.passwordOn") : t("admin.general.passwordOff")}
          </dd>
        </dl>
      </AdminCard>
    </div>
  );
}
