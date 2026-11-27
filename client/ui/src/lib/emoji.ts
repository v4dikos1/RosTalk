/**
 * Common emoji for the message composer (P31).
 *
 * The picker is built in on purpose: no runtime dependency is allowed, and the
 * compact set is enough for a chat message. Keywords cover Russian and English
 * so the same list is searchable in both interface languages. Names are data,
 * not interface copy: the picker shows only the glyph.
 */
export interface EmojiEntry {
  char: string;
  keywords: readonly string[];
}

export const COMMON_EMOJI: readonly EmojiEntry[] = [
  { char: "😀", keywords: ["grin", "smile", "улыбка", "смех", "радость"] },
  { char: "😄", keywords: ["smile", "happy", "улыбка", "радость"] },
  { char: "😁", keywords: ["grin", "teeth", "ухмылка", "зубы"] },
  { char: "😂", keywords: ["joy", "tears", "laugh", "слёзы", "смех"] },
  { char: "🤣", keywords: ["rofl", "laugh", "смех", "катаюсь"] },
  { char: "😊", keywords: ["blush", "smile", "смущение", "улыбка"] },
  { char: "🙂", keywords: ["smile", "улыбка"] },
  { char: "😉", keywords: ["wink", "подмигивание"] },
  { char: "😍", keywords: ["love", "hearts", "любовь", "влюблён"] },
  { char: "😘", keywords: ["kiss", "поцелуй"] },
  { char: "😎", keywords: ["cool", "glasses", "крутой", "очки"] },
  { char: "🤔", keywords: ["think", "думаю", "размышление"] },
  { char: "😐", keywords: ["neutral", "нейтрально"] },
  { char: "🙁", keywords: ["sad", "грустно"] },
  { char: "😢", keywords: ["cry", "tears", "плачу", "слёзы"] },
  { char: "😡", keywords: ["angry", "злость"] },
  { char: "😱", keywords: ["shock", "scream", "шок", "крик"] },
  { char: "🥳", keywords: ["party", "праздник", "вечеринка"] },
  { char: "👍", keywords: ["like", "ok", "палец вверх", "хорошо"] },
  { char: "👎", keywords: ["dislike", "палец вниз", "плохо"] },
  { char: "👏", keywords: ["clap", "аплодисменты"] },
  { char: "🙏", keywords: ["please", "thanks", "спасибо", "пожалуйста"] },
  { char: "🤝", keywords: ["handshake", "рукопожатие", "сделка"] },
  { char: "✌️", keywords: ["victory", "peace", "мир", "победа"] },
  { char: "🤙", keywords: ["call", "позвони"] },
  { char: "👀", keywords: ["eyes", "look", "глаза", "смотрю"] },
  { char: "💪", keywords: ["muscle", "strong", "сила"] },
  { char: "🫡", keywords: ["salute", "честь"] },
  { char: "🔥", keywords: ["fire", "огонь", "класс"] },
  { char: "⭐", keywords: ["star", "звезда"] },
  { char: "✨", keywords: ["sparkles", "блеск", "искры"] },
  { char: "🎉", keywords: ["party", "tada", "праздник"] },
  { char: "🎊", keywords: ["confetti", "конфетти"] },
  { char: "❤️", keywords: ["heart", "love", "сердце", "любовь"] },
  { char: "🧡", keywords: ["heart", "orange", "сердце"] },
  { char: "💔", keywords: ["broken heart", "разбитое сердце"] },
  { char: "💯", keywords: ["hundred", "сто", "сотня"] },
  { char: "✅", keywords: ["check", "done", "галочка", "готово"] },
  { char: "❌", keywords: ["cross", "no", "крестик", "нет"] },
  { char: "⚠️", keywords: ["warning", "предупреждение"] },
  { char: "❓", keywords: ["question", "вопрос"] },
  { char: "❗", keywords: ["exclamation", "восклицание"] },
  { char: "💡", keywords: ["idea", "идея", "лампочка"] },
  { char: "📌", keywords: ["pin", "закрепить"] },
  { char: "📎", keywords: ["paperclip", "скрепка"] },
  { char: "📝", keywords: ["memo", "note", "заметка"] },
  { char: "📅", keywords: ["calendar", "календарь", "дата"] },
  { char: "⏰", keywords: ["alarm", "time", "будильник", "время"] },
  { char: "🚀", keywords: ["rocket", "ракета", "запуск"] },
  { char: "🎮", keywords: ["game", "геймпад", "игра"] },
  { char: "🎧", keywords: ["headphones", "наушники", "музыка"] },
  { char: "🎵", keywords: ["music", "note", "музыка", "нота"] },
  { char: "☕", keywords: ["coffee", "кофе"] },
  { char: "🍕", keywords: ["pizza", "пицца"] },
  { char: "🍻", keywords: ["beer", "пиво"] },
  { char: "🎂", keywords: ["cake", "birthday", "торт", "день рождения"] },
  { char: "☀️", keywords: ["sun", "солнце"] },
  { char: "🌙", keywords: ["moon", "луна"] },
  { char: "🌧️", keywords: ["rain", "дождь"] },
  { char: "❄️", keywords: ["snow", "снег"] },
  { char: "🐱", keywords: ["cat", "кот", "кошка", "котёнок"] },
  { char: "🐶", keywords: ["dog", "собака", "пёс"] },
  { char: "🦊", keywords: ["fox", "лиса"] },
  { char: "🌈", keywords: ["rainbow", "радуга"] },
  { char: "👋", keywords: ["wave", "hi", "bye", "привет", "пока"] },
  { char: "🤗", keywords: ["hug", "обнять"] },
  { char: "🤷", keywords: ["shrug", "не знаю"] },
  { char: "🙈", keywords: ["monkey", "обезьяна", "стесняюсь"] },
  { char: "💤", keywords: ["sleep", "сон", "устал"] },
  { char: "🎯", keywords: ["target", "dart", "цель", "дартс"] },
];

/**
 * Filters the set by a Russian or English keyword. An empty query returns the
 * whole set, so the picker opens on a compact grid.
 */
export function filterEmoji(
  query: string,
  entries: readonly EmojiEntry[] = COMMON_EMOJI,
): EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...entries];
  }
  return entries.filter(
    (entry) =>
      entry.char === needle ||
      entry.keywords.some((keyword) => keyword.toLowerCase().includes(needle)),
  );
}
