import { describe, it, expect, beforeEach } from "vitest";
import localesFactory from "../../server/services/locales.js";

const makeStrapi = (i18nLocales, opts = {}) => {
  const warnings = [];
  return {
    log: {
      warn: (msg) => warnings.push(msg),
      info: () => {},
      error: () => {},
    },
    plugin: (id) => {
      if (id === "i18n") {
        if (opts.noI18n) return {};
        if (opts.throwI18n) {
          return {
            service: () => ({
              find: async () => {
                throw new Error("i18n exploded");
              },
            }),
          };
        }
        return {
          service: (name) => {
            if (name !== "locales") throw new Error("unexpected");
            return {
              find: async () => i18nLocales,
              getDefaultLocale: async () => opts.defaultLocale,
            };
          },
        };
      }
      if (id === "translate") return { config: { sourceLocale: opts.sourceLocale } };
      return {};
    },
    _warnings: warnings,
  };
};

describe("locales service", () => {
  it("returns the i18n locale list", async () => {
    const strapi = makeStrapi([
      { code: "de", name: "German", isDefault: true },
      { code: "en", name: "English", isDefault: false },
    ]);
    const svc = localesFactory({ strapi });
    const snap = await svc.snapshot();
    expect(snap.fallback).toBe(false);
    expect(snap.list).toHaveLength(2);
    expect([...snap.codes]).toEqual(["de", "en"]);
  });

  // i18n's find() returns raw rows; the default lives in the core store.
  it("marks the i18n default locale as default", async () => {
    const strapi = makeStrapi(
      [
        { code: "en", name: "English" },
        { code: "de", name: "German" },
      ],
      { defaultLocale: "de", sourceLocale: "en" }
    );
    const svc = localesFactory({ strapi });
    expect(await svc.list()).toEqual([
      { code: "en", name: "English", isDefault: false },
      { code: "de", name: "German", isDefault: true },
    ]);
  });

  it("falls back to settings.sourceLocale when i18n has no usable default", async () => {
    const strapi = makeStrapi(
      [
        { code: "en", name: "English" },
        { code: "de", name: "German" },
      ],
      { defaultLocale: "fr", sourceLocale: "de" }
    );
    const svc = localesFactory({ strapi });
    const defaults = (await svc.list()).filter((l) => l.isDefault);
    expect(defaults.map((l) => l.code)).toEqual(["de"]);
  });

  it("memoizes within the TTL window", async () => {
    let calls = 0;
    const strapi = {
      log: { warn: () => {}, info: () => {}, error: () => {} },
      plugin: () => ({
        service: () => ({
          find: async () => {
            calls += 1;
            return [{ code: "de", name: "German" }];
          },
        }),
      }),
    };
    const svc = localesFactory({ strapi });
    await svc.snapshot();
    await svc.snapshot();
    await svc.snapshot();
    expect(calls).toBe(1);
  });

  it("re-reads when invalidated", async () => {
    let calls = 0;
    const strapi = {
      log: { warn: () => {}, info: () => {}, error: () => {} },
      plugin: () => ({
        service: () => ({
          find: async () => {
            calls += 1;
            return [{ code: "de", name: "German" }];
          },
        }),
      }),
    };
    const svc = localesFactory({ strapi });
    await svc.snapshot();
    svc.invalidate();
    await svc.snapshot();
    expect(calls).toBe(2);
  });

  it("falls back when i18n is missing", async () => {
    const strapi = makeStrapi(null, { noI18n: true });
    const svc = localesFactory({ strapi });
    const snap = await svc.snapshot();
    expect(snap.fallback).toBe(true);
    expect(snap.list.length).toBeGreaterThan(0);
    expect(strapi._warnings.some((w) => /i18n.*not available/i.test(w))).toBe(true);
  });

  it("falls back when i18n throws", async () => {
    const strapi = makeStrapi(null, { throwI18n: true });
    const svc = localesFactory({ strapi });
    const snap = await svc.snapshot();
    expect(snap.fallback).toBe(true);
    expect(strapi._warnings.some((w) => /failed to read locales/i.test(w))).toBe(true);
  });

  it("falls back when i18n returns an empty list", async () => {
    const strapi = makeStrapi([]);
    const svc = localesFactory({ strapi });
    const snap = await svc.snapshot();
    expect(snap.fallback).toBe(true);
  });

  it("has() returns true/false correctly", async () => {
    const strapi = makeStrapi([{ code: "de", name: "German" }]);
    const svc = localesFactory({ strapi });
    expect(await svc.has("de")).toBe(true);
    expect(await svc.has("zh")).toBe(false);
    expect(await svc.has("")).toBe(false);
    expect(await svc.has(null)).toBe(false);
  });
});
