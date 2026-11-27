/**
 * Message composer sizing (P31).
 *
 * The textarea grows with its content up to a cap. The one-pixel tolerance
 * keeps WebView2 on Windows 10 from showing a native scrollbar for a field that
 * is not really overflowing: that engine rounds a fractional line box up and
 * reports a scrollHeight one pixel above clientHeight.
 */
export const COMPOSER_MAX_HEIGHT = 132;

export interface ComposerMetrics {
  /** Height in CSS pixels, never above the cap. */
  height: number;
  /** Whether the content is taller than the cap and needs a scrollbar. */
  overflowing: boolean;
}

export function composerMetrics(naturalHeight: number): ComposerMetrics {
  return {
    height: Math.min(naturalHeight, COMPOSER_MAX_HEIGHT),
    overflowing: naturalHeight > COMPOSER_MAX_HEIGHT + 1,
  };
}
