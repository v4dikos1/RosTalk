import { Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { coreApi } from "@/core";
import type { CoreError } from "@/core/api";
import { asCoreError, coreErrorText } from "@/lib/coreError";
import { useAppStore } from "@/store/appStore";
import { useCoreStore } from "@/store/coreStore";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * Password prompt for a protected channel. The client does not decide whether
 * the password is right (stage 2.4 requirement 10): it sends it and shows the
 * server's answer in human language.
 */
export function ChannelPasswordDialog() {
  const channelId = useAppStore((state) => state.channelPasswordId);
  if (channelId === null) {
    return null;
  }
  return <ChannelPasswordContent key={channelId} channelId={channelId} />;
}

function ChannelPasswordContent({ channelId }: { channelId: number }) {
  const { t } = useTranslation();
  const close = useAppStore((state) => state.closeChannelPassword);
  const state = useCoreStore((store) => store.state);
  const updateSettings = useSettingsStore((store) => store.update);
  const channel = state?.channels.find((item) => item.id === channelId);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<CoreError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || password.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await coreApi.joinChannel(channelId, password);
      await updateSettings({ defaultChannelId: channelId });
      close();
    } catch (reason) {
      setError(asCoreError(reason));
    } finally {
      setBusy(false);
    }
  }

  const errorText = error ? coreErrorText(error) : null;

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="w-[min(420px,92vw)]"
        closeLabel={t("common.close")}
        data-testid="channel-password"
      >
        <form onSubmit={(event) => void submit(event)}>
          <header className="border-b border-border px-4 py-3 pr-12">
            <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold">
              <Lock className="size-4 text-accent" aria-hidden />
              {t("channel.passwordTitle", {
                channel: channel?.name ?? "",
              })}
            </DialogTitle>
            <DialogDescription className="text-[12px] text-muted">
              {t("channel.passwordHint")}
            </DialogDescription>
          </header>
          <div className="space-y-2 p-4">
            <Input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
              aria-label={t("channel.passwordField")}
              data-testid="channel-password-input"
            />
            {errorText ? (
              <p
                role="alert"
                className="text-[12px] text-danger"
                title={errorText.detail}
              >
                {t(errorText.key)}
              </p>
            ) : null}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || password.length === 0}
              data-testid="channel-password-submit"
            >
              {t("channel.join")}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
