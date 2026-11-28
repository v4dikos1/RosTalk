import { type Ref } from "react";
import backgroundImage from "@/assets/newyear/background-winter-night.webp";
import treeImage from "@/assets/newyear/tree-base.webp";
import type { ArtLocale } from "../locales/art";
import { Button } from "@/components/ui/button";
import { artLabels } from "../locales/art";
import { Ornament } from "./Ornament";
import "./scene.css";

export type Placement = { itemId: string; x: number; y: number; scale: number; rotation: number };
export function growthScale(days: number) {
  return days >= 31 ? 1 : days >= 24 ? 0.92 : days >= 16 ? 0.8 : days >= 8 ? 0.7 : days >= 1 ? 0.6 : 0.5;
}
export function isWithinCrown(x: number, y: number) {
  return Number.isInteger(x) && Number.isInteger(y) && y >= 140 && y <= 930 && Math.abs(x - 500) <= Math.floor(0.42 * y) - 35;
}

export function Scene({ growthDays, background, placements, locale = "ru", crownRef, onSelect }: {
  growthDays: number;
  background: "dusk" | "aurora";
  placements: Placement[];
  locale?: ArtLocale;
  crownRef?: Ref<HTMLDivElement>;
  onSelect?: (index: number) => void;
}) {
  return <div className="new-year-game ny-scene" role="group" aria-label={artLabels[locale].scene} data-background={background}>
    <img className="ny-backdrop" src={backgroundImage} alt="" />
    {background === "aurora" && <div className="ny-aurora" aria-hidden="true" />}
    <div className="ny-atmosphere" aria-hidden="true" />
    <div className="ny-snow" aria-hidden="true" />
    <div className="ny-tree" style={{ height: `${90 * growthScale(growthDays)}%` }}>
      <img className="ny-tree-image" src={treeImage} alt="" />
      <div className="ny-crown" ref={crownRef}>
        {placements.map((placement, index) => {
          const style = { left: `${placement.x / 10}%`, top: `${placement.y / 10}%`, transform: `translate(-50%, -50%) rotate(${placement.rotation}deg) scale(${placement.scale / 100})` };
          const ornament = <Ornament itemId={placement.itemId} locale={locale} />;
          return onSelect
            ? <Button variant="ghost" key={index} className="ny-placement" style={style} onClick={() => onSelect(index)}>{ornament}</Button>
            : <div key={index} className="ny-placement" style={style}>{ornament}</div>;
        })}
      </div>
    </div>
  </div>;
}
