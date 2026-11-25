/**
 * OKLCH → linear sRGB → WCAG relative luminance. Shared by the token and
 * avatar contrast tests; production Tauri/WebView2 does the conversion itself.
 */

export type Oklch = readonly [number, number, number];

/** OKLCH → linear sRGB (Björn Ottosson's matrices). */
export function oklchToLinearRgb([l, c, h]: Oklch): [number, number, number] {
  const angle = (h * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ];
  const [ll, mm, ss] = lms.map((value) => value ** 3) as [
    number,
    number,
    number,
  ];
  return [
    4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
  ];
}

export function luminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio of two colours. */
export function contrast(a: Oklch, b: Oklch): number {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Parses a plain `oklch(L C H)` token; throws on anything else. */
export function parseOklch(value: string): Oklch {
  const match = value.match(
    /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*[0-9.]+)?\s*\)$/,
  );
  if (!match) {
    throw new Error(`not a plain oklch token: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
