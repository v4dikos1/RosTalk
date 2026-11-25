import { useEffect, useState } from "react";

/** Below this width the member pane is an overlay and starts hidden. */
export const COMPACT_LAYOUT_MAX_WIDTH = 1099;

/**
 * Current window width in CSS pixels, updated on resize.
 *
 * The desktop shell zooms the WebView natively, so `innerWidth` is the layout
 * width the user actually sees; DPI scaling does not change it.
 */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return width;
}
