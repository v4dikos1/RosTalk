import logo from "@/assets/brand/logo.png";

/**
 * The RosTalk mark: the rose with the voice indicator. The same image is used
 * everywhere in the shell (P30); size and placement come from `className`, so
 * each spot keeps the box it had when the mark was a lucide icon.
 */
export function BrandMark({ className }: { className?: string }) {
  return <img src={logo} alt="" aria-hidden className={className} />;
}
