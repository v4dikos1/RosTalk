import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { en } from "./en";
import { ru } from "./ru";

// The persisted language is applied by `App` once the core settings load; the
// initial resource avoids a flash of untranslated keys.
void i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    en: { translation: en },
  },
  lng: "ru",
  fallbackLng: "en",
  supportedLngs: ["ru", "en"],
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
});

export { i18n };
