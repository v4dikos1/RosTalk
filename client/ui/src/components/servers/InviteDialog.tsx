import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore } from "@/store/appStore";

import { InviteForm } from "./InviteForm";

/** Invite dialog opened from the server menu. The form is shared with the sidebar popover. */
export function InviteDialog() {
  const { t } = useTranslation();
  const open = useAppStore((store) => store.inviteOpen);
  const close = useAppStore((store) => store.closeInvite);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        className="w-[min(380px,92vw)] p-5"
        closeLabel={t("common.close")}
        data-testid="invite-dialog"
      >
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-accent/15 text-accent">
            <UserPlus className="size-4" aria-hidden />
          </span>
          <div>
            <DialogTitle className="text-[14px] font-semibold text-foreground">
              {t("invite.title")}
            </DialogTitle>
            <DialogDescription className="text-[12px] text-muted">
              {t("invite.hint")}
            </DialogDescription>
          </div>
        </div>
        <InviteForm showHint={false} />
      </DialogContent>
    </Dialog>
  );
}
