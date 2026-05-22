import { describe, it, expect, beforeEach } from "vitest";
import autoFactory, { ruleMatches } from "../../server/services/auto-translate.js";

describe("auto-translate", () => {
  describe("ruleMatches", () => {
    it("matches by uid + action", () => {
      const rule = { uid: "api::page.page", on: "publish", targetLocales: ["en"] };
      expect(
        ruleMatches(rule, { uid: "api::page.page", action: "publish", locale: "de" })
      ).toBe(true);
      expect(
        ruleMatches(rule, { uid: "api::other.x", action: "publish", locale: "de" })
      ).toBe(false);
      expect(
        ruleMatches(rule, { uid: "api::page.page", action: "update", locale: "de" })
      ).toBe(false);
    });

    it("respects sourceLocale filter", () => {
      const rule = {
        uid: "api::page.page",
        on: "publish",
        sourceLocale: "de",
        targetLocales: ["en"],
      };
      expect(
        ruleMatches(rule, { uid: "api::page.page", action: "publish", locale: "de" })
      ).toBe(true);
      expect(
        ruleMatches(rule, { uid: "api::page.page", action: "publish", locale: "en" })
      ).toBe(false);
    });

    it("matches all actions when on is omitted", () => {
      const rule = { uid: "api::page.page", targetLocales: ["en"] };
      expect(
        ruleMatches(rule, { uid: "api::page.page", action: "publish", locale: "de" })
      ).toBe(true);
      expect(
        ruleMatches(rule, { uid: "api::page.page", action: "update", locale: "de" })
      ).toBe(true);
    });
  });

  describe("install", () => {
    it("noop when config has no rules", () => {
      const strapi = {
        log: { warn: () => {}, info: () => {}, error: () => {} },
        plugin: () => ({ config: { autoTranslate: { enabled: true, rules: [] } } }),
        documents: { use: () => {} },
      };
      const svc = autoFactory({ strapi });
      svc._reset();
      const res = svc.install();
      expect(res.installed).toBe(0);
    });

    it("noop when disabled", () => {
      const strapi = {
        log: { warn: () => {}, info: () => {}, error: () => {} },
        plugin: () => ({
          config: { autoTranslate: { enabled: false, rules: [{}] } },
        }),
        documents: { use: () => {} },
      };
      const svc = autoFactory({ strapi });
      svc._reset();
      expect(svc.install().installed).toBe(0);
    });

    it("registers middleware with rules", () => {
      const calls = [];
      const strapi = {
        log: { warn: () => {}, info: () => {}, error: () => {} },
        plugin: () => ({
          config: {
            autoTranslate: {
              enabled: true,
              rules: [
                {
                  uid: "api::page.page",
                  sourceLocale: "de",
                  targetLocales: ["en"],
                  on: "publish",
                },
              ],
            },
          },
        }),
        documents: {
          use: (fn) => {
            calls.push(fn);
          },
        },
      };
      const svc = autoFactory({ strapi });
      svc._reset();
      const res = svc.install();
      expect(res.installed).toBe(1);
      expect(calls).toHaveLength(1);
      expect(typeof calls[0]).toBe("function");
    });

    it("install is idempotent", () => {
      let registrations = 0;
      const strapi = {
        log: { warn: () => {}, info: () => {}, error: () => {} },
        plugin: () => ({
          config: { autoTranslate: { enabled: true, rules: [{ uid: "x", targetLocales: ["en"] }] } },
        }),
        documents: { use: () => { registrations += 1; } },
      };
      const svc = autoFactory({ strapi });
      svc._reset();
      svc.install();
      svc.install();
      expect(registrations).toBe(1);
    });
  });
});
