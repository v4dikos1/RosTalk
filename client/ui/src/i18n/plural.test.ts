import { i18n } from "@/i18n";

/**
 * Russian needs three plural forms; the badges used to show "1 непрочитанных"
 * and "1 упоминаний". The English forms are checked too because it is the
 * fallback language.
 */
describe("plural forms", () => {
  afterEach(async () => {
    await i18n.changeLanguage("ru");
  });

  it("uses the Russian one/few/many forms for unread and mentions", async () => {
    await i18n.changeLanguage("ru");

    expect(i18n.t("tree.unread", { count: 1 })).toBe("1 непрочитанное");
    expect(i18n.t("tree.unread", { count: 2 })).toBe("2 непрочитанных");
    expect(i18n.t("tree.unread", { count: 5 })).toBe("5 непрочитанных");

    expect(i18n.t("tree.mentions", { count: 1 })).toBe("1 упоминание");
    expect(i18n.t("tree.mentions", { count: 2 })).toBe("2 упоминания");
    expect(i18n.t("tree.mentions", { count: 5 })).toBe("5 упоминаний");

    expect(i18n.t("invite.usesMany", { count: 1 })).toBe("1 вход");
    expect(i18n.t("invite.usesMany", { count: 2 })).toBe("2 входа");
    expect(i18n.t("invite.usesMany", { count: 5 })).toBe("5 входов");
  });

  it("keeps the English singular and plural", async () => {
    await i18n.changeLanguage("en");

    expect(i18n.t("tree.unread", { count: 1 })).toBe("1 unread");
    expect(i18n.t("tree.unread", { count: 2 })).toBe("2 unread");
    expect(i18n.t("tree.unread", { count: 5 })).toBe("5 unread");

    expect(i18n.t("tree.mentions", { count: 1 })).toBe("1 mention");
    expect(i18n.t("tree.mentions", { count: 2 })).toBe("2 mentions");
    expect(i18n.t("tree.mentions", { count: 5 })).toBe("5 mentions");

    expect(i18n.t("invite.usesMany", { count: 1 })).toBe("1 join");
    expect(i18n.t("invite.usesMany", { count: 2 })).toBe("2 joins");
    expect(i18n.t("invite.usesMany", { count: 5 })).toBe("5 joins");
  });
});
