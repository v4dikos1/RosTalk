/**
 * Deterministic avatar colour.
 *
 * The hash covers `serverId:userId` only: a nickname change must not recolor a
 * person, and two servers may reuse numeric ids. The eight hues share one
 * lightness, so the background/text contrast is identical for every palette
 * entry and can be checked once in `avatar.test.ts`.
 */

export const AVATAR_HUES = [28, 55, 95, 150, 195, 225, 275, 330] as const;

/** FNV-1a, 32 bit. Stable across platforms and JS engines. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Palette index of one person on one server. */
export function avatarIndex(
  serverId: string | null | undefined,
  userId: number,
): number {
  return fnv1a(`${serverId ?? "local"}:${userId}`) % AVATAR_HUES.length;
}

export interface AvatarPalette {
  /** Solid fill of the rounded square. */
  background: string;
  /** Initials; tuned to stay ≥ 4.5:1 on the fill. */
  foreground: string;
}

/**
 * Colour pair of a palette index. Lightness and chroma are theme tokens
 * (`--avatar-fill-*`, `--avatar-ink-*` in index.css): dark presets use a deep
 * fill with light initials, the light preset a soft fill with dark initials.
 * `tokens.test.ts` checks every hue of every preset against WCAG AA.
 */
export function avatarPalette(index: number): AvatarPalette {
  const hue = AVATAR_HUES[index] ?? AVATAR_HUES[0];
  return {
    background: `oklch(var(--avatar-fill-l) var(--avatar-fill-c) ${hue})`,
    foreground: `oklch(var(--avatar-ink-l) var(--avatar-ink-c) ${hue})`,
  };
}

/** Convenience wrapper used by components and tests. */
export function avatarColors(
  serverId: string | null | undefined,
  userId: number,
): AvatarPalette {
  return avatarPalette(avatarIndex(serverId, userId));
}
