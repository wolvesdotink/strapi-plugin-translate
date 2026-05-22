import { describe, it, expect } from "vitest";
import factory from "../../server/services/settings.js";

const makeStrapi = ({ defaults, stored, supportedCodes = ["de", "en", "fr"] }) => {
  const storeData = new Map();
  if (stored) storeData.set("settings", stored);
  const localesSvc = {
    async list() {
      return supportedCodes.map((code) => ({ code, name: code, isDefault: code === "de" }));
    },
    async codes() {
      return new Set(supportedCodes);
    },
  };
  return {
    log: { warn: () => {}, info: () => {}, error: () => {} },
    store: () => ({
      async get() {
        return storeData.get("settings");
      },
      async set({ value }) {
        storeData.set("settings", value);
      },
    }),
    plugin: () => ({
      defaults: defaults || { voice: "", glossary: { preserveExact: [], perLocale: {} } },
      service: (n) => (n === "locales" ? localesSvc : null),
    }),
    _data: storeData,
  };
};

describe("settings service", () => {
  it("returns defaults when nothing stored", async () => {
    const strapi = makeStrapi({
      defaults: { voice: "warm", glossary: { preserveExact: ["Brand"], perLocale: {} } },
    });
    const svc = factory({ strapi });
    const value = await svc.get();
    expect(value.voice).toBe("warm");
    expect(value.glossary.preserveExact).toEqual(["Brand"]);
    expect(Object.keys(value.glossary.perLocale).sort()).toEqual(["de", "en", "fr"]);
  });

  it("trims voice and dedupes preserveExact", async () => {
    const strapi = makeStrapi({});
    const svc = factory({ strapi });
    const value = await svc.set({
      voice: "  hi  ",
      glossary: { preserveExact: ["a", "a", "b", "  "], perLocale: {} },
    });
    expect(value.voice).toBe("hi");
    expect(value.glossary.preserveExact).toEqual(["a", "b"]);
  });

  it("drops perLocale entries for unsupported codes", async () => {
    const strapi = makeStrapi({});
    const svc = factory({ strapi });
    const value = await svc.set({
      voice: "",
      glossary: {
        preserveExact: [],
        perLocale: { en: { a: "b" }, xx: { y: "z" } },
      },
    });
    expect(Object.keys(value.glossary.perLocale).sort()).toEqual(["de", "en", "fr"]);
    expect(value.glossary.perLocale.en).toEqual({ a: "b" });
    expect(value.glossary.perLocale.xx).toBeUndefined();
  });

  it("reset() returns defaults", async () => {
    const strapi = makeStrapi({
      defaults: { voice: "default", glossary: { preserveExact: ["X"], perLocale: {} } },
      stored: { voice: "overridden", glossary: { preserveExact: [], perLocale: {} } },
    });
    const svc = factory({ strapi });
    const after = await svc.reset();
    expect(after.voice).toBe("default");
    expect(after.glossary.preserveExact).toEqual(["X"]);
  });

  it("supportedLocales() returns the dynamic codes", async () => {
    const strapi = makeStrapi({ supportedCodes: ["de", "en", "fr", "pl"] });
    const svc = factory({ strapi });
    const codes = await svc.supportedLocales();
    expect(codes).toEqual(["de", "en", "fr", "pl"]);
  });
});
