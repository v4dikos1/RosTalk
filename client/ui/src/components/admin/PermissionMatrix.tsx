import { useTranslation } from "react-i18next";

import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  PERMISSION_GROUPS,
  type PermissionDefinition,
} from "@/lib/permissions";
import { cn } from "@/lib/utils";

export function PermissionMatrix({
  value,
  onChange,
  disabled = false,
  groups = ["server", "moderation", "channel", "misc"],
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  groups?: PermissionDefinition["group"][];
}) {
  const { t } = useTranslation();
  const selected = new Set(value);

  function toggle(name: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) {
      next.add(name);
    } else {
      next.delete(name);
    }
    onChange([...next]);
  }

  return (
    <div className="space-y-3">
      {PERMISSION_GROUPS.filter((group) => groups.includes(group.id)).map((group) => (
        <div key={group.id}>
          <h4 className="mb-1 text-[11px] font-medium text-faint">
            {t(`admin.permissionGroup.${group.id}`)}
          </h4>
          <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
            {group.permissions.map((definition) => {
              const checked = selected.has(definition.name);
              return (
                <Tooltip key={definition.name}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-sm px-1.5 py-1",
                        disabled ? "opacity-60" : "hover:bg-hover",
                      )}
                    >
                      <span className="min-w-0 truncate text-[12px] text-foreground">
                        {t(`admin.permission.${definition.name}.label`)}
                      </span>
                      <Switch
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={(next) => toggle(definition.name, next)}
                        aria-label={t(`admin.permission.${definition.name}.label`)}
                        data-testid={`permission-${definition.name}`}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    {t(`admin.permission.${definition.name}.hint`)}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
