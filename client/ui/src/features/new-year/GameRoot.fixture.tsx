import { createRoot, type Root } from "react-dom/client";
import { i18n } from "@/i18n";
import "@/index.css";
import "@/reduced-motion.css";
import type { GameState, GameTarget } from "./api";
import GameRoot from "./GameRoot";
import { FakeServer, makeState, PROXY } from "./server.fixture";

export interface Fixture {
  server: FakeServer;
  mount(options?: { locale?: "ru" | "en"; theme?: "dark" | "light"; state?: Partial<GameState>; target?: GameTarget }): Promise<void>;
  unmount(): void;
  closed: number;
}

let root: Root | null = null;
const fixture: Fixture = {
  server: new FakeServer(),
  closed: 0,
  async mount({ locale = "en", theme = "dark", state = {}, target = { kind: "self" } as GameTarget } = {}) {
    root?.unmount();
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.preset = theme === "dark" ? "rostalk" : "paper";
    await i18n.changeLanguage(locale);
    fixture.server = new FakeServer(makeState(state));
    fixture.server.trees.set(11, { growthDays: 12, background: "dusk", placements: [{ itemId: "ball-red", x: 500, y: 600, scale: 100, rotation: 0 }] });
    fixture.server.trees.set(12, null);
    window.fetch = fixture.server.fetch;
    const container = document.getElementById("game-test") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "game-test" }));
    root = createRoot(container);
    root.render(<GameRoot proxy={PROXY} serverId="fixture" selfId={7} target={target} onClose={() => { fixture.closed += 1; fixture.unmount(); }} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
(window as unknown as { nyFixture: Fixture }).nyFixture = fixture;
