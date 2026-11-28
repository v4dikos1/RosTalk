export const artLabels = {
  en: {
    unknown: "Unknown ornament",
    items: ["Red bauble", "Gold bauble", "Blue bauble", "Candy cane", "Pine cone", "Snowflake", "Glass house bauble", "Golden bell", "Ribbon bow", "Silver icicle", "Aurora bauble", "Snow globe", "Gingerbread house", "Star topper", "Golden deer", "Midnight clock"],
    scene: "New Year tree",
  },
  ru: {
    unknown: "Неизвестная игрушка",
    items: ["Красный шар", "Золотой шар", "Синий шар", "Леденец", "Шишка", "Снежинка", "Шар с домиком", "Золотой колокольчик", "Бант", "Серебряная сосулька", "Северное сияние", "Снежный шар", "Пряничный домик", "Звезда", "Золотой олень", "Полуночные часы"],
    scene: "Новогодняя ёлка",
  },
} as const;
export type ArtLocale = keyof typeof artLabels;
