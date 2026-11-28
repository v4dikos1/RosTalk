import type { PublicTree } from "./api";
import { Scene } from "./art/Scene";
import type { ArtLocale } from "./locales/art";

export function TreeViewer({ tree, locale }: { tree: PublicTree; locale: ArtLocale }) {
  return <Scene {...tree} locale={locale} />;
}
