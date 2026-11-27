import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { ServerProbeView } from "@/core/api";
import { cn } from "@/lib/utils";

/**
 * The certificate a direct login would pin. A DNS name goes through Web PKI
 * and only needs a confirmation line, while an IP host shows the digest; the
 * first contact and a changed certificate must be confirmed explicitly.
 */
export function CertificatePanel({
  probe,
  trusted,
  onTrust,
}: {
  probe: ServerProbeView;
  trusted: boolean;
  onTrust: () => void;
}) {
  const { t } = useTranslation();
  const pinned = probe.mode === "pinned";
  const firstContact = pinned && probe.knownFingerprint === null;
  const needsTrust =
    pinned && (probe.certificateChanged || probe.knownFingerprint === null);

  if (!pinned) {
    return (
      <div
        className="flex items-start gap-1.5 rounded-sm border border-border bg-raised px-2.5 py-2 text-[11px] text-muted"
        data-testid="connect-certificate"
      >
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
        <span>{t("connect.certificateWebPkiHint", { host: probe.hostname })}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-1.5 rounded-sm border px-2.5 py-2",
        probe.certificateChanged
          ? "border-danger/40 bg-danger/10"
          : "border-border bg-raised",
      )}
      data-testid="connect-certificate"
    >
      <p className="text-[11px] font-medium text-foreground">
        {probe.certificateChanged
          ? t("connect.certificateChanged")
          : firstContact
            ? t("connect.certificateNew")
            : t("connect.certificateTitle")}
      </p>
      <p
        className="break-all font-mono text-[11px] text-muted select-text"
        data-testid="connect-fingerprint"
      >
        {probe.fingerprint}
      </p>
      {probe.certificateChanged ? (
        <>
          <p className="break-all font-mono text-[10px] text-faint line-through select-text">
            {probe.knownFingerprint}
          </p>
          <p className="text-[11px] leading-snug text-muted">
            {t("connect.certificateChangedHint")}
          </p>
        </>
      ) : firstContact ? (
        <p className="text-[11px] leading-snug text-muted">
          {t("connect.certificateNewHint")}
        </p>
      ) : (
        <p className="text-[11px] leading-snug text-muted">
          {t("connect.certificateHint")}
        </p>
      )}
      {needsTrust ? (
        trusted ? (
          <p className="text-[11px] font-medium text-success">
            {probe.certificateChanged
              ? t("connect.certificateAccepted")
              : t("connect.certificateTrusted")}
          </p>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onTrust}
            data-testid="connect-trust"
          >
            {probe.certificateChanged
              ? t("connect.trustCertificate")
              : t("connect.trustNewCertificate")}
          </Button>
        )
      ) : null}
    </div>
  );
}
