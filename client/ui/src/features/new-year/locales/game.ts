import { i18n } from "@/i18n";
import { gameEn } from "./game.en";
import { gameRu } from "./game.ru";

export const GAME_NS = "nyGame";

i18n.addResourceBundle("ru", GAME_NS, gameRu, true, true);
i18n.addResourceBundle("en", GAME_NS, gameEn, true, true);
