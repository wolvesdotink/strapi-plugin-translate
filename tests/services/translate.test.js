import { describe, it, expect, beforeEach } from "vitest";
import translateFactory from "../../server/services/translate.js";
import fieldsFactory from "../../server/services/translatable-fields.js";
import formatFactory from "../../server/services/format.js";
import chunksFactory from "../../server/services/chunks.js";
import cacheFactory from "../../server/services/cache.js";

// Build a "real enough" strapi for the orchestrator: real translatable-fields,
// real format/chunks/cache, real settings shape — only the provider and the
// documents/db layer are mocked.

const makePlugin = ({ strapi, provider, providerCalls, models }) => {
  const settingsValue = {
    voice: "warm",
    glossary: { preserveExact: ["Hinterland Camp"], perLocale: {} },
  };
  const services = {
    "translatable-fields": fieldsFactory,
    format: formatFactory,
    chunks: chunksFactory,
    cache: cacheFactory,
    settings: () => ({
      async get() {
        return settingsValue;
      },
    }),
    locales: () => ({
      async list() {
        return [
          { code: "de", name: "German", isDefault: true },
          { code: "en", name: "English" },
          { code: "fr", name: "French" },
        ];
      },
      async codes() {
        return new Set(["de", "en", "fr"]);
      },
    }),
  };
  const instances = {};
  const ns = {
    provider,
    config: { sourceLocale: "de" },
    defaults: { voice: "warm", glossary: { preserveExact: [], perLocale: {} } },
    service: (name) => {
      if (instances[name]) return instances[name];
      const factory = services[name];
      if (!factory) return null;
      instances[name] = typeof factory === "function" ? factory({ strapi }) : factory;
      return instances[name];
    },
    _settingsValue: settingsValue,
  };
  return ns;
};

const buildStrapi = ({ models, sourceEntry, provider }) => {
  const upserts = [];
  const stored = new Map();
  const strapi = {
    log: { warn: () => {}, info: () => {}, error: () => {} },
    config: { get: () => ({}) },
    getModel: (uid) => models[uid],
    db: {
      query: () => ({ async findMany() { return []; } }),
    },
    documents: (uid) => ({
      async findOne({ locale }) {
        if (locale === "de") return sourceEntry;
        return null;
      },
      async update({ documentId, locale, data }) {
        upserts.push({ uid, documentId, locale, data });
        return { documentId, locale, ...data };
      },
    }),
    store: (descriptor) => ({
      async get() {
        return stored.get(JSON.stringify(descriptor));
      },
      async set({ value }) {
        stored.set(JSON.stringify(descriptor), value);
      },
    }),
    requestContext: { get: () => ({ state: { user: { id: null } } }) },
  };
  const ns = makePlugin({ strapi, provider, models });
  strapi.plugin = (id) => {
    if (id === "translate") return ns;
    if (id === "i18n") {
      return {
        service: () => ({
          async find() {
            return [
              { code: "de", name: "German", isDefault: true },
              { code: "en", name: "English" },
            ];
          },
        }),
      };
    }
    return {};
  };
  return { strapi, upserts, plugin: ns };
};

describe("translate orchestrator", () => {
  const models = {
    "api::page.page": {
      kind: "collectionType",
      attributes: {
        title: {
          type: "string",
          pluginOptions: { translate: { translate: "translate" } },
        },
        body: {
          type: "richtext",
          pluginOptions: { translate: { translate: "translate" } },
        },
        slug: {
          type: "uid",
          pluginOptions: { translate: { translate: "translate" } },
        },
        published: { type: "boolean" },
      },
    },
  };

  it("translates fields and upserts target locale", async () => {
    const providerCalls = [];
    const provider = {
      async translate({ text, format }) {
        providerCalls.push({ text, format });
        return text.map((t) => `EN[${t}]`);
      },
      async usage() {
        return { count: 0, limit: null };
      },
    };
    const sourceEntry = {
      documentId: "doc-1",
      locale: "de",
      title: "Hallo",
      body: "<p>Welt</p>",
      slug: "hallo",
      published: true,
    };
    const { strapi, upserts } = buildStrapi({ models, sourceEntry, provider });
    const svc = translateFactory({ strapi });
    const out = await svc.translateDocument({
      uid: "api::page.page",
      documentId: "doc-1",
      sourceLocale: "de",
      targetLocale: "en",
    });
    expect(out.entry.title).toBe("EN[Hallo]");
    expect(out.entry.body).toBe("EN[<p>Welt</p>]");
    // slug is regenerate — never set in the upsert payload
    expect(out.entry.slug).toBeUndefined();
    // copied non-translatable scalar
    expect(out.entry.published).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].locale).toBe("en");
  });

  it("hits cache on second translation", async () => {
    let providerCallCount = 0;
    const provider = {
      async translate({ text }) {
        providerCallCount += 1;
        return text.map((t) => `EN[${t}]`);
      },
      async usage() {
        return { count: 0, limit: null };
      },
    };
    const sourceEntry = {
      documentId: "doc-1",
      locale: "de",
      title: "Hallo",
      body: null,
      slug: null,
      published: true,
    };
    const { strapi } = buildStrapi({ models, sourceEntry, provider });
    const svc = translateFactory({ strapi });
    await svc.translateDocument({
      uid: "api::page.page",
      documentId: "doc-1",
      sourceLocale: "de",
      targetLocale: "en",
    });
    const firstCalls = providerCallCount;
    expect(firstCalls).toBeGreaterThan(0);
    // Second call should hit cache entirely
    await svc.translateDocument({
      uid: "api::page.page",
      documentId: "doc-1",
      sourceLocale: "de",
      targetLocale: "en",
    });
    expect(providerCallCount).toBe(firstCalls);
  });

  it("estimate() returns token + cost approximation", async () => {
    const provider = {
      async translate({ text }) {
        return text.map((t) => t);
      },
      async usage() {
        return { count: 0, limit: null };
      },
      async estimate({ text }) {
        const chars = text.reduce((a, s) => a + s.length, 0);
        return {
          inputTokens: Math.ceil(chars / 4),
          estimatedOutputTokens: Math.ceil(chars / 3),
          estimatedCostUsd: 0.001,
          items: text.length,
        };
      },
    };
    const sourceEntry = {
      documentId: "doc-1",
      locale: "de",
      title: "Hallo Welt",
      body: "<p>Hier ist Text</p>",
      slug: null,
      published: false,
    };
    const { strapi } = buildStrapi({ models, sourceEntry, provider });
    const svc = translateFactory({ strapi });
    const est = await svc.estimate({
      uid: "api::page.page",
      documentId: "doc-1",
      sourceLocale: "de",
      targetLocales: ["en", "fr"],
    });
    expect(est.targets).toBe(2);
    expect(est.inputTokens).toBeGreaterThan(0);
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
    expect(est.groups.plain.items).toBe(1); // title
    expect(est.groups.html.items).toBe(1); // body
    // No existing entries for these locales in this test setup.
    expect(est.perLocale.find((p) => p.locale === "en").exists).toBe(false);
    expect(est.perLocale.find((p) => p.locale === "fr").exists).toBe(false);
    expect(Array.isArray(est.components)).toBe(true);
  });

  it("estimate() flags existing target locales", async () => {
    const provider = {
      async translate({ text }) {
        return text;
      },
      async usage() {
        return { count: 0, limit: null };
      },
    };
    const sourceEntry = {
      documentId: "doc-1",
      locale: "de",
      title: "Hallo Welt",
      body: null,
      slug: null,
      published: false,
    };
    const upserts = [];
    const stored = new Map();
    const strapi = {
      log: { warn: () => {}, info: () => {}, error: () => {} },
      config: { get: () => ({}) },
      getModel: (uid) => models[uid],
      db: { query: () => ({ async findMany() { return []; } }) },
      documents: (uid) => ({
        async findOne({ locale }) {
          if (locale === "de") return sourceEntry;
          if (locale === "en") {
            return { documentId: "doc-1", locale: "en", title: "Hello" };
          }
          return null;
        },
        async update({ documentId, locale, data }) {
          upserts.push({ uid, documentId, locale, data });
          return { documentId, locale, ...data };
        },
      }),
      store: (descriptor) => ({
        async get() {
          return stored.get(JSON.stringify(descriptor));
        },
        async set({ value }) {
          stored.set(JSON.stringify(descriptor), value);
        },
      }),
      requestContext: { get: () => ({ state: { user: { id: null } } }) },
    };
    const ns = makePlugin({ strapi, provider, models });
    strapi.plugin = (id) => {
      if (id === "translate") return ns;
      return {};
    };
    const svc = translateFactory({ strapi });
    const est = await svc.estimate({
      uid: "api::page.page",
      documentId: "doc-1",
      sourceLocale: "de",
      targetLocales: ["en", "fr"],
    });
    expect(est.perLocale.find((p) => p.locale === "en").exists).toBe(true);
    expect(est.perLocale.find((p) => p.locale === "fr").exists).toBe(false);
  });

  it("translateDocumentDry returns the proposed payload without upserting", async () => {
    const provider = {
      async translate({ text }) {
        return text.map((t) => `EN[${t}]`);
      },
      async usage() {
        return { count: 0, limit: null };
      },
    };
    const sourceEntry = {
      documentId: "doc-1",
      locale: "de",
      title: "Hallo",
      body: null,
      slug: null,
      published: true,
    };
    const { strapi, upserts } = buildStrapi({ models, sourceEntry, provider });
    const svc = translateFactory({ strapi });
    const computed = await svc.translateDocumentDry({
      uid: "api::page.page",
      documentId: "doc-1",
      sourceLocale: "de",
      targetLocale: "en",
    });
    expect(computed.proposed.title).toBe("EN[Hallo]");
    expect(upserts).toHaveLength(0);
  });

  it("aborts cleanly when signal is aborted", async () => {
    const provider = {
      async translate({ text }) {
        return text.map((t) => `EN[${t}]`);
      },
      async usage() {
        return { count: 0, limit: null };
      },
    };
    const sourceEntry = {
      documentId: "doc-1",
      locale: "de",
      title: "Hallo",
      body: null,
      slug: null,
      published: true,
    };
    const { strapi } = buildStrapi({ models, sourceEntry, provider });
    const svc = translateFactory({ strapi });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      svc.translateDocument({
        uid: "api::page.page",
        documentId: "doc-1",
        sourceLocale: "de",
        targetLocale: "en",
        signal: ctrl.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when source equals target", async () => {
    const provider = { async translate() { return []; }, async usage() { return {}; } };
    const sourceEntry = { documentId: "d", locale: "de", title: "x", body: null, slug: null, published: false };
    const { strapi } = buildStrapi({ models, sourceEntry, provider });
    const svc = translateFactory({ strapi });
    await expect(
      svc.translateDocument({
        uid: "api::page.page",
        documentId: "d",
        sourceLocale: "de",
        targetLocale: "de",
      })
    ).rejects.toThrow(/must differ/);
  });
});
