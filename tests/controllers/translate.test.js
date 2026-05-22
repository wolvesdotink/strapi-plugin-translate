import { describe, it, expect, beforeEach } from "vitest";
import controllerFactory from "../../server/controllers/translate.js";

// The controller is a thin HTTP adapter. We exercise each new endpoint via a
// minimal ctx mock with mocked plugin services. Strapi production wiring
// (policies, the routes layer) is exercised end-to-end by the smoke test.

const noop = () => {};

// Permissive ability that grants every action on every uid — used by tests
// that aren't exercising the RBAC filter itself.
const allowAll = { can: () => true };

const makeCtx = (overrides = {}) => {
  const ctx = {
    request: { body: overrides.body || {} },
    params: overrides.params || {},
    query: overrides.query || {},
    state: overrides.state || { user: { id: 1 }, userAbility: allowAll },
    status: 200,
    body: undefined,
    badRequest: (message) => {
      ctx.status = 400;
      ctx.body = { error: { message } };
      return ctx.body;
    },
    notFound: (message) => {
      ctx.status = 404;
      ctx.body = { error: { message } };
      return ctx.body;
    },
    forbidden: (message) => {
      ctx.status = 403;
      ctx.body = { error: { message } };
      return ctx.body;
    },
    throw: (code, message) => {
      const err = new Error(message);
      err.status = code;
      throw err;
    },
  };
  return ctx;
};

const makeStrapi = ({
  jobs = null,
  documentsByUid = {},
  contentTypes = {},
  models = {},
  fieldsDescribe,
  localesList,
} = {}) => {
  const services = {
    jobs: () => jobs || { list: () => [] },
    translate: () => ({}),
    settings: () => ({}),
    locales: () => ({
      async list() {
        return (
          localesList || [
            { code: "de", name: "German", isDefault: true },
            { code: "en", name: "English" },
            { code: "fr", name: "French" },
          ]
        );
      },
      async codes() {
        const list =
          localesList || [
            { code: "de", name: "German", isDefault: true },
            { code: "en", name: "English" },
            { code: "fr", name: "French" },
          ];
        return new Set(list.map((l) => l.code));
      },
    }),
    cache: () => ({}),
    preview: () => ({}),
    "translatable-fields": () => ({
      describe: (uid) => {
        if (typeof fieldsDescribe === "function") return fieldsDescribe(uid);
        return { uid, attributes: [] };
      },
    }),
  };
  return {
    log: { info: noop, warn: noop, error: noop },
    contentTypes,
    getModel: (uid) => models[uid],
    documents: (uid) => documentsByUid[uid] || { async findOne() { return null; }, async findMany() { return []; } },
    plugin: (id) => {
      if (id !== "translate") return {};
      return {
        service: (name) => {
          const factory = services[name];
          if (typeof factory === "function") return factory();
          return null;
        },
      };
    },
  };
};

describe("translate controller — listJobs", () => {
  it("returns most-recent-first jobs trimmed to limit", async () => {
    const jobList = [
      { id: "a", uid: "api::page.page", startedAt: 1000, state: "done" },
      { id: "b", uid: "api::page.page", startedAt: 3000, state: "failed" },
      { id: "c", uid: "api::page.page", startedAt: 2000, state: "running" },
    ];
    const strapi = makeStrapi({
      jobs: { list: () => jobList },
    });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({ query: { limit: "2" } });
    await ctrl.listJobs(ctx);
    expect(ctx.body.total).toBe(3);
    expect(ctx.body.jobs.map((j) => j.id)).toEqual(["b", "c"]);
  });

  it("filters by content-type permission when userAbility present", async () => {
    const jobList = [
      { id: "a", uid: "api::page.page", startedAt: 1000 },
      { id: "b", uid: "api::secret.secret", startedAt: 2000 },
    ];
    const strapi = makeStrapi({ jobs: { list: () => jobList } });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({
      state: {
        user: { id: 1 },
        userAbility: {
          can: (_action, uid) => uid !== "api::secret.secret",
        },
      },
    });
    await ctrl.listJobs(ctx);
    expect(ctx.body.jobs.map((j) => j.id)).toEqual(["a"]);
    expect(ctx.body.total).toBe(1);
  });

  it("clamps limit to 200", async () => {
    // Build 250 jobs so the slice can actually surface a difference between
    // "honoured 9999" (250 jobs) and "clamped to 200" (200 jobs).
    const jobList = Array.from({ length: 250 }, (_, i) => ({
      id: `j-${i}`,
      uid: "api::page.page",
      startedAt: i,
      state: "done",
    }));
    const strapi = makeStrapi({ jobs: { list: () => jobList } });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({ query: { limit: "9999" } });
    await ctrl.listJobs(ctx);
    expect(ctx.body.jobs.length).toBe(200);
    expect(ctx.body.total).toBe(250);
  });

  it("fails closed when userAbility is missing", async () => {
    const jobList = [
      { id: "a", uid: "api::page.page", startedAt: 1, state: "done" },
    ];
    const strapi = makeStrapi({ jobs: { list: () => jobList } });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({ state: { user: { id: 1 }, userAbility: null } });
    await ctrl.listJobs(ctx);
    expect(ctx.body.jobs).toEqual([]);
    expect(ctx.body.total).toBe(0);
  });
});

describe("translate controller — localeStatus", () => {
  it("returns exists=true only where a draft entry exists", async () => {
    const docs = {
      "api::page.page": {
        async findOne({ locale }) {
          if (locale === "de") {
            return { documentId: "doc-1", locale: "de", title: "Hallo" };
          }
          if (locale === "en") {
            return { documentId: "doc-1", locale: "en", title: "Hello" };
          }
          return null;
        },
      },
    };
    const strapi = makeStrapi({ documentsByUid: docs });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({
      body: { uid: "api::page.page", documentId: "doc-1" },
    });
    await ctrl.localeStatus(ctx);
    const by = Object.fromEntries(ctx.body.locales.map((l) => [l.locale, l]));
    expect(by.de.exists).toBe(true);
    expect(by.en.exists).toBe(true);
    expect(by.fr.exists).toBe(false);
  });

  it("400s without uid + documentId", async () => {
    const strapi = makeStrapi();
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({ body: { uid: "api::page.page" } });
    await ctrl.localeStatus(ctx);
    expect(ctx.status).toBe(400);
  });

  it("returns exists=false when findOne throws", async () => {
    const docs = {
      "api::page.page": {
        async findOne() {
          throw new Error("boom");
        },
      },
    };
    const strapi = makeStrapi({ documentsByUid: docs });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({
      body: { uid: "api::page.page", documentId: "doc-1" },
    });
    await ctrl.localeStatus(ctx);
    for (const l of ctx.body.locales) expect(l.exists).toBe(false);
  });
});

describe("translate controller — contentTypes", () => {
  it("returns only localized CTs with a translate-directive field", async () => {
    const contentTypes = {
      "api::page.page": {
        kind: "collectionType",
        info: { displayName: "Page" },
        pluginOptions: { i18n: { localized: true } },
      },
      "api::nope.nope": {
        // not localized
        kind: "collectionType",
        info: { displayName: "Nope" },
      },
      "api::nofields.nofields": {
        kind: "collectionType",
        info: { displayName: "NoFields" },
        pluginOptions: { i18n: { localized: true } },
      },
      "plugin::user.user": {
        // not api::
        kind: "collectionType",
        info: { displayName: "User" },
        pluginOptions: { i18n: { localized: true } },
      },
    };
    const strapi = makeStrapi({
      contentTypes,
      fieldsDescribe: (uid) => {
        if (uid === "api::page.page") {
          return {
            uid,
            attributes: [
              { name: "title", type: "string", directive: "translate" },
            ],
          };
        }
        if (uid === "api::nofields.nofields") {
          return {
            uid,
            attributes: [{ name: "n", type: "integer", directive: "copy" }],
          };
        }
        return { uid, attributes: [] };
      },
    });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx();
    await ctrl.contentTypes(ctx);
    expect(ctx.body.contentTypes.map((c) => c.uid)).toEqual([
      "api::page.page",
    ]);
    expect(ctx.body.contentTypes[0].translatableFieldCount).toBe(1);
  });

  it("fails closed when userAbility is missing", async () => {
    const contentTypes = {
      "api::page.page": {
        kind: "collectionType",
        info: { displayName: "Page" },
        pluginOptions: { i18n: { localized: true } },
      },
    };
    const strapi = makeStrapi({
      contentTypes,
      fieldsDescribe: () => ({
        uid: "x",
        attributes: [{ name: "title", type: "string", directive: "translate" }],
      }),
    });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({ state: { user: { id: 1 }, userAbility: null } });
    await ctrl.contentTypes(ctx);
    expect(ctx.body.contentTypes).toEqual([]);
  });

  it("filters CTs by read permission when userAbility present", async () => {
    const contentTypes = {
      "api::page.page": {
        kind: "collectionType",
        info: { displayName: "Page" },
        pluginOptions: { i18n: { localized: true } },
      },
      "api::secret.secret": {
        kind: "collectionType",
        info: { displayName: "Secret" },
        pluginOptions: { i18n: { localized: true } },
      },
    };
    const strapi = makeStrapi({
      contentTypes,
      fieldsDescribe: () => ({
        uid: "x",
        attributes: [{ name: "title", type: "string", directive: "translate" }],
      }),
    });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({
      state: {
        user: { id: 1 },
        userAbility: {
          can: (_a, uid) => uid !== "api::secret.secret",
        },
      },
    });
    await ctrl.contentTypes(ctx);
    expect(ctx.body.contentTypes.map((c) => c.uid)).toEqual(["api::page.page"]);
  });
});

describe("translate controller — contentList", () => {
  it("returns documents with best-effort label", async () => {
    const docs = {
      "api::page.page": {
        async findMany({ locale }) {
          if (locale === "de") {
            return [
              { documentId: "a", title: "Hallo" },
              { documentId: "b", title: "Welt" },
            ];
          }
          return [];
        },
      },
    };
    const strapi = makeStrapi({
      documentsByUid: docs,
      models: {
        "api::page.page": {
          attributes: { title: { type: "string" } },
        },
      },
    });
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({
      body: { uid: "api::page.page", sourceLocale: "de" },
    });
    await ctrl.contentList(ctx);
    expect(ctx.body.documents).toEqual([
      { documentId: "a", label: "Hallo", updatedAt: null },
      { documentId: "b", label: "Welt", updatedAt: null },
    ]);
  });

  it("400s without uid", async () => {
    const strapi = makeStrapi();
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({ body: {} });
    await ctrl.contentList(ctx);
    expect(ctx.status).toBe(400);
  });
});
