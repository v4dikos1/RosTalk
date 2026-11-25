import type { RoleView } from "@/core/api";

/**
 * Display name of a role. Built-in roles arrive from the server in English
 * (`Admin`, `Moderator`, `Member`, `Guest`) and are translated by their stable
 * name; custom roles keep exactly what the administrator typed.
 */
export function roleName(
  role: Pick<RoleView, "name" | "builtin"> | null | undefined,
  t: (key: string) => string,
): string {
  if (!role) {
    return "";
  }
  if (!role.builtin) {
    return role.name;
  }
  const key = `users.roleNames.${role.name.trim().toLowerCase()}`;
  const translated = t(key);
  return translated === key ? role.name : translated;
}

/**
 * Inline style that draws a role colour in a nickname (stage P9: the role
 * lives in the name, the avatar ring is reserved for speaking).
 *
 * Administrators pick any colour, including pale yellow on the light theme, so
 * the colour is mixed with a quarter of the theme foreground: it keeps its hue
 * and gains contrast against either background. Anything but `#rrggbb` is
 * ignored rather than passed into CSS.
 */
export function roleNameStyle(
  color: string | null | undefined,
): { color: string } | undefined {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return undefined;
  }
  return { color: `color-mix(in oklch, ${color} 75%, var(--foreground))` };
}
