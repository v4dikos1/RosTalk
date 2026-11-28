import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { itemName, MAX_PLACEMENTS, rarityOf, type GameState, type Placement } from "./api";
import { Scene } from "./art/Scene";
import { Ornament } from "./art/Ornament";
import type { ArtLocale } from "./locales/art";
import type { LayoutDraft } from "./store";
import { clampCrown } from "./placement";
import "./editor.css";

const labels = {
  en: { inventory: "Inventory", unused: "unused", place: "Select an ornament, then tap the tree or press Enter to place it.", scale: "Scale", rotation: "Rotation", remove: "Remove", reset: "Reset", save: "Save", conflict: "The tree changed elsewhere. Reload or reapply your draft.", reload: "Reload", reapply: "Reapply", background: "Background", dusk: "Dusk", aurora: "Aurora", empty: "No ornaments yet" },
  ru: { inventory: "Игрушки", unused: "осталось", place: "Выберите игрушку и нажмите на ёлку или Enter, чтобы разместить её.", scale: "Размер", rotation: "Поворот", remove: "Убрать", reset: "Сбросить", save: "Сохранить", conflict: "Ёлка изменилась на другом устройстве. Загрузите её или примените черновик повторно.", reload: "Загрузить", reapply: "Применить снова", background: "Фон", dusk: "Сумерки", aurora: "Сияние", empty: "Игрушек пока нет" },
} as const;

export function TreeEditor({ state, draft, busy, conflict, error, locale, onDraft, onSave, onReload, onReapply }: { state: GameState; draft: LayoutDraft | null; busy: boolean; conflict: boolean; error: string; locale: ArtLocale; onDraft: (draft: LayoutDraft) => void; onSave: () => void; onReload: () => void; onReapply: () => void }) {
  const t = labels[locale];
  const current = draft ?? { baseVersion: state.layout.version, background: state.layout.background, placements: state.layout.placements };
  const [item, setItem] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const crown = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const active = selected === null ? undefined : current.placements[selected];
  const update = (placements: Placement[]) => onDraft({ ...current, placements });
  const move = (index: number, x: number, y: number) => update(current.placements.map((p, i) => i === index ? { ...p, ...clampCrown(x, y) } : p));
  const point = (event: PointerEvent) => {
    const box = crown.current?.getBoundingClientRect();
    return box ? clampCrown((event.clientX - box.left) / box.width * 1000, (event.clientY - box.top) / box.height * 1000) : null;
  };
  const add = (x = 500, y = 600) => {
    if (!item || current.placements.length >= MAX_PLACEMENTS) return;
    const owned = state.inventory.find((entry) => entry.itemId === item)?.qty ?? 0;
    if (current.placements.filter((p) => p.itemId === item).length >= owned) return;
    update([...current.placements, { itemId: item, ...clampCrown(x, y), scale: 100, rotation: 0 }]);
    setSelected(current.placements.length);
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (state.phase !== "active" || !crown.current?.contains(event.target as Node)) return;
    const button = (event.target as HTMLElement).closest("button.ny-placement");
    const index = button ? Array.from(crown.current.children).indexOf(button) : -1;
    if (index >= 0) { setSelected(index); dragging.current = index; event.currentTarget.setPointerCapture(event.pointerId); }
    else { const p = point(event); if (p) add(p.x, p.y); }
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (selected === null || !active) return;
    const step = event.shiftKey ? 50 : 10;
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const offset = offsets[event.key];
    if (offset) { event.preventDefault(); const [dx, dy] = offset; move(selected, active.x + dx, active.y + dy); }
    if (event.key === "Delete") { event.preventDefault(); update(current.placements.filter((_, i) => i !== selected)); setSelected(null); }
  };
  const edit = (change: Partial<Placement>) => { if (selected !== null) update(current.placements.map((p, i) => i === selected ? { ...p, ...change } : p)); };
  return <div className="ny-editor">
    <div onPointerDown={pointerDown} onPointerMove={(event) => { if (dragging.current !== null) { const p = point(event); if (p) move(dragging.current, p.x, p.y); } }} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }} onKeyDown={key}>
      <Scene growthDays={state.growthDays} background={current.background} placements={current.placements} locale={locale} crownRef={crown} onSelect={setSelected} />
    </div>
    <div className="ny-editor-controls">
      <h2>{t.inventory}</h2><p>{t.place}</p>
      {state.inventory.length === 0 && <p>{t.empty}</p>}
      <div className="ny-inventory">{state.inventory.map(({ itemId, qty }) => { const unused = qty - current.placements.filter((p) => p.itemId === itemId).length; return <Button variant="ghost" className={`ny-inventory-item ny-border-${rarityOf(itemId) ?? "common"}`} key={itemId} disabled={unused <= 0 || busy || state.phase !== "active"} aria-pressed={item === itemId} onClick={() => setItem(itemId)} onKeyDown={(event) => { if (event.key === "Enter" && item === itemId) { event.preventDefault(); add(); } }}><Ornament itemId={itemId} locale={locale} /><span>{itemName(itemId, locale)}<small>{unused} / {qty} {t.unused}</small></span></Button>; })}</div>
      <div className="ny-background-control"><span>{t.background}</span><Segmented value={current.background} label={t.background} options={state.unlockedBackgrounds.map((background) => ({ value: background, label: t[background] }))} onChange={(background) => { if (!busy && state.phase === "active") onDraft({ ...current, background }); }} /></div>
      {active && <><div className="ny-adjust"><label htmlFor="ny-scale">{t.scale}</label><Slider aria-label={t.scale} min="60" max="140" value={active.scale} onChange={(e) => edit({ scale: Number(e.target.value) })} /><Input id="ny-scale" type="number" min="60" max="140" value={active.scale} onChange={(e) => edit({ scale: Math.max(60, Math.min(140, Number(e.target.value))) })} /></div><div className="ny-adjust"><label htmlFor="ny-rotation">{t.rotation}</label><Slider aria-label={t.rotation} min="-45" max="45" value={active.rotation} onChange={(e) => edit({ rotation: Number(e.target.value) })} /><Input id="ny-rotation" type="number" min="-45" max="45" step="1" value={active.rotation} onChange={(e) => edit({ rotation: Math.max(-45, Math.min(45, Math.round(Number(e.target.value)))) })} /></div><Button variant="ghost" className="ny-remove" onClick={() => { update(current.placements.filter((_, i) => i !== selected)); setSelected(null); }}>{t.remove}</Button></>}
      {error && <p role="alert">{error}</p>}{conflict && <><p role="alert">{t.conflict}</p><Button onClick={onReload}>{t.reload}</Button><Button onClick={onReapply}>{t.reapply}</Button></>}
      <div className="ny-editor-actions"><Button variant="ghost" disabled={busy || state.phase !== "active"} onClick={() => { onDraft({ ...current, background: "dusk", placements: [] }); setSelected(null); }}>{t.reset}</Button> <Button disabled={busy || !draft || conflict || state.phase !== "active"} onClick={onSave}>{t.save}</Button></div>
    </div>
  </div>;
}
