import { createRoot } from "react-dom/client";
import { Scene } from "./Scene";

const root = createRoot(document.getElementById("art-test")!);
(window as unknown as { renderArt: (days: number, background: "dusk" | "aurora") => void }).renderArt = (days, background) => root.render(<Scene growthDays={days} background={background} locale="en" placements={[
  { itemId: "ball-red", x: 500, y: 600, scale: 140, rotation: -20 },
  { itemId: "ball-blue", x: 500, y: 600, scale: 100, rotation: 15 },
  { itemId: "unknown", x: 500, y: 780, scale: 100, rotation: 0 },
]} />);
