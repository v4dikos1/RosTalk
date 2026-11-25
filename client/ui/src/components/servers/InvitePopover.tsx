import { UserPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { InviteForm } from "./InviteForm";

/**
 * Quick invite for the channel header: a Member link that lives 24 hours and
 * can be used up to five times. The form is shared with the server-menu dialog.
 *
 * The panel is a Radix Popover: portalled to the body and kept inside the
 * window, so the sidebar footer and the channel header cannot clip it.
 */
export function InvitePopover({
  up = false,
  withLabel = false,
}: {
  /** Open above the trigger, for the sidebar footer. */
  up?: boolean;
  withLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size={withLabel ? "sm" : "icon-sm"}
          className={withLabel ? "flex-1 justify-start" : undefined}
          aria-label={t("main.invite")}
          data-testid="invite-open"
        >
          <UserPlus className="size-3.5" aria-hidden />
          {withLabel ? t("main.invite") : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label={t("main.invite")}
        data-testid="invite-popover"
        side={up ? "top" : "bottom"}
        align={up ? "start" : "end"}
        className="w-80 p-3 text-left"
      >
        <p className="text-[13px] font-semibold text-foreground">
          {t("invite.title")}
        </p>
        <InviteForm />
      </PopoverContent>
    </Popover>
  );
}
