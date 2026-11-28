import red from "@/assets/newyear/ornaments/ball-red.webp";
import gold from "@/assets/newyear/ornaments/ball-gold.webp";
import blue from "@/assets/newyear/ornaments/ball-blue.webp";
import candy from "@/assets/newyear/ornaments/candy-cane.webp";
import cone from "@/assets/newyear/ornaments/pine-cone.webp";
import snowflake from "@/assets/newyear/ornaments/snowflake.webp";
import house from "@/assets/newyear/ornaments/ball-glass-house.webp";
import bell from "@/assets/newyear/ornaments/bell-gold.webp";
import bow from "@/assets/newyear/ornaments/ribbon-bow.webp";
import icicle from "@/assets/newyear/ornaments/icicle-silver.webp";
import aurora from "@/assets/newyear/ornaments/ball-aurora.webp";
import globe from "@/assets/newyear/ornaments/snow-globe.webp";
import gingerbread from "@/assets/newyear/ornaments/gingerbread-house.webp";
import star from "@/assets/newyear/ornaments/star-topper.webp";
import deer from "@/assets/newyear/ornaments/deer-gold.webp";
import clock from "@/assets/newyear/ornaments/clock-midnight.webp";
import { artLabels, type ArtLocale } from "../locales/art";
import "./scene.css";

export const ornamentUrls: Record<string, string> = {
  "ball-red": red, "ball-gold": gold, "ball-blue": blue, "candy-cane": candy,
  "pine-cone": cone, snowflake, "ball-glass-house": house, "bell-gold": bell,
  "ribbon-bow": bow, "icicle-silver": icicle, "ball-aurora": aurora,
  "snow-globe": globe, "gingerbread-house": gingerbread, "star-topper": star,
  "deer-gold": deer, "clock-midnight": clock,
};
const ids = Object.keys(ornamentUrls);

export function Ornament({ itemId, locale = "ru" }: { itemId: string; locale?: ArtLocale }) {
  const index = ids.indexOf(itemId);
  const label = index < 0 ? artLabels[locale].unknown : artLabels[locale].items[index];
  const url = Object.hasOwn(ornamentUrls, itemId) ? ornamentUrls[itemId] : undefined;
  return url ? <img className="ny-ornament-image" src={url} alt={label} draggable={false} /> :
    <span className="ny-ornament-fallback" role="img" aria-label={label}>
      <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 3.8l3 2.2 3-2.2M9 20.2l3-2.2 3 2.2" /></svg>
    </span>;
}
