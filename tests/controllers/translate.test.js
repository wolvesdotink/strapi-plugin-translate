import { describe, it, expect, beforeEach } from "vitest";
import controllerFactory from "../../server/controllers/translate.js";
import jobsFactory from "../../server/services/jobs.js";

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
  translateService,
} = {}) => {
  const services = {
    jobs: () => jobs || { list: () => [] },
    translate: () => translateService || {},
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

describe("scoped preview job access", () => {
  it("keeps staged field values private to the editor who generated them", async () => {
    const jobs = { get: () => ({ id:"job",uid:"api::page.page",source:"preview",userId:2,targets:[{result:{modules:[{fields:[{after:"Private translation"}]}]}}] }) };
    const controller = controllerFactory({strapi:makeStrapi({jobs})});
    const ctx = makeCtx({params:{id:"job"}});
    await controller.getJob(ctx);
    expect(ctx.status).toBe(404);
    expect(JSON.stringify(ctx.body)).not.toContain("Private translation");
  });
  it("does not let another editor cancel a scoped preview job", async () => {
    let cancelled = false;
    const jobs = { get: () => ({id:"job",uid:"api::page.page",source:"preview",userId:2}), cancel:()=>{cancelled=true;return {ok:true};} };
    const controller = controllerFactory({strapi:makeStrapi({jobs})});
    const ctx = makeCtx({params:{id:"job"}});
    await controller.cancelJob(ctx);
    expect(ctx.status).toBe(404);
    expect(cancelled).toBe(false);
  });
  it("omits other editors' previews and strips staged values from history", async () => {
    const jobs = { list:()=>[
      {id:"mine",uid:"api::page.page",source:"preview",userId:1,targets:[{result:{previewId:"change_a",modules:[{fields:[{after:"Private translation"}]}]}}]},
      {id:"theirs",uid:"api::page.page",source:"preview",userId:2,targets:[]},
    ] };
    const controller = controllerFactory({strapi:makeStrapi({jobs})});
    const ctx=makeCtx();await controller.listJobs(ctx);
    expect(ctx.body.jobs.map(j=>j.id)).toEqual(["mine"]);
    expect(JSON.stringify(ctx.body)).not.toContain("Private translation");
  });
});

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

describe("translate controller — bulk translate into a locale", () => {
  const localized = (displayName, attributes = {}) => ({
    kind: "collectionType",
    info: { displayName },
    pluginOptions: { i18n: { localized: true } },
    attributes,
  });
  const contentTypes = {
    "api::article.article": localized("Article", {
      title: { type: "string" },
      category: { type: "relation", relation: "manyToOne", target: "api::category.category" },
    }),
    "api::category.category": localized("Category", {
      name: { type: "string" },
      // Not copied by translations (relations default to "skip"), so it
      // must not make Category depend on Article.
      featured: { type: "relation", relation: "oneToOne", target: "api::article.article" },
    }),
    "api::secret.secret": localized("Secret", { title: { type: "string" } }),
  };
  // documentIds per uid and locale.
  const initialRows = () => ({
    "api::article.article": { de: ["a1", "a2"], en: ["a1"], fr: [] },
    "api::category.category": { de: ["c1"], en: [], fr: [] },
    "api::secret.secret": { de: ["s1"], en: [], fr: [] },
  });
  let rows = initialRows();
  const documentsByUid = Object.fromEntries(
    Object.keys(rows).map((uid) => [
      uid,
      {
        async findMany({ locale }) {
          return (rows[uid][locale] || []).map((documentId) => ({ documentId }));
        },
        async findOne({ documentId, locale }) {
          return (rows[uid][locale] || []).includes(documentId) ? { documentId } : null;
        },
      },
    ])
  );
  const setup = ({ can = () => true, calls = [], onTranslate } = {}) => {
    const strapi = makeStrapi({
      contentTypes,
      models: contentTypes,
      documentsByUid,
      fieldsDescribe: (uid) => ({
        uid,
        attributes: [
          { name: "title", type: "string", directive: "translate" },
          ...(uid === "api::article.article"
            ? [{ name: "category", type: "relation", directive: "copy", target: "api::category.category" }]
            : []),
          ...(uid === "api::category.category"
            ? [{ name: "featured", type: "relation", directive: "skip", target: "api::article.article" }]
            : []),
        ],
      }),
      translateService: {
        async translateDocument(args) {
          onTranslate?.(args);
          calls.push(`${args.uid}:${args.documentId}:${args.targetLocale}`);
          return { entry: { documentId: args.documentId, locale: args.targetLocale }, warnings: [] };
        },
      },
    });
    const jobs = jobsFactory({ strapi: { ...strapi, plugin: () => ({ config: { persistJobs: false } }) } });
    strapi.plugin = ((orig) => (id) => {
      const p = orig(id);
      return { ...p, service: (name) => (name === "jobs" ? jobs : p.service(name)) };
    })(strapi.plugin);
    const ability = { can };
    return { ctrl: controllerFactory({ strapi }), jobs, ability };
  };
  const ctxFor = (ability, body) => makeCtx({ body, state: { user: { id: 1 }, userAbility: ability } });
  const waitFor = async (jobs, id) => {
    for (let i = 0; i < 50; i++) {
      const snap = jobs.get(id);
      if (["done", "failed", "cancelled", "partial"].includes(snap.state)) return snap;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("job did not finish");
  };

  beforeEach(() => {
    jobsFactory({ strapi: {} })._reset();
    rows = initialRows();
  });

  it("reports missing documents per target locale, limited to types the caller can update", async () => {
    const { ctrl, ability } = setup({
      can: (action, uid) => !(uid === "api::secret.secret" && action.endsWith(".update")),
    });
    const ctx = ctxFor(ability, { sourceLocale: "de", targetLocales: ["en", "fr"] });
    await ctrl.localeCoverage(ctx);
    expect(ctx.body.contentTypes.map((c) => [c.uid, c.sourceCount, c.missing])).toEqual([
      ["api::article.article", 2, { en: 1, fr: 2 }],
      ["api::category.category", 1, { en: 1, fr: 1 }],
    ]);
  });

  it("translates only what is missing, linked types first", async () => {
    const calls = [];
    const { ctrl, jobs, ability } = setup({ calls });
    // Category listed first: only Article's copied link counts, so
    // Category still goes first.
    const ctx = ctxFor(ability, {
      sourceLocale: "de",
      targetLocales: ["en", "fr"],
      uids: ["api::category.category", "api::article.article"],
    });
    await ctrl.bulkTranslateLocale(ctx);
    expect(ctx.status).toBe(202);
    const snap = await waitFor(jobs, ctx.body.jobId);
    expect(calls).toEqual([
      "api::category.category:c1:en",
      "api::category.category:c1:fr",
      "api::article.article:a1:fr",
      "api::article.article:a2:en",
      "api::article.article:a2:fr",
    ]);
    expect(snap.state).toBe("done");
    expect(snap.uid).toBe(null);
    expect(snap.uids).toEqual(["api::category.category", "api::article.article"]);
    expect(snap.targets.map((t) => t.state)).toEqual(["done", "done"]);
  });

  it("retranslates everything when onlyMissing is false", async () => {
    const calls = [];
    const { ctrl, jobs, ability } = setup({ calls });
    const ctx = ctxFor(ability, {
      sourceLocale: "de",
      targetLocales: ["en"],
      uids: ["api::article.article"],
      onlyMissing: false,
    });
    await ctrl.bulkTranslateLocale(ctx);
    await waitFor(jobs, ctx.body.jobId);
    expect(calls).toEqual(["api::article.article:a1:en", "api::article.article:a2:en"]);
  });

  it("400s when every document already exists in the target locale", async () => {
    const { ctrl, ability } = setup();
    const ctx = ctxFor(ability, {
      sourceLocale: "en",
      targetLocales: ["de"],
      uids: ["api::article.article"],
    });
    await ctrl.bulkTranslateLocale(ctx);
    expect(ctx.status).toBe(400);
  });

  it("403s for a content type the caller cannot update", async () => {
    const { ctrl, ability } = setup({
      can: (action, uid) => !(uid === "api::secret.secret" && action.endsWith(".update")),
    });
    const ctx = ctxFor(ability, {
      sourceLocale: "de",
      targetLocales: ["en"],
      uids: ["api::secret.secret"],
    });
    await ctrl.bulkTranslateLocale(ctx);
    expect(ctx.status).toBe(403);
  });

  it("hides a multi-type job from editors who cannot read one of its types", async () => {
    const { ctrl, jobs, ability } = setup();
    const ctx = ctxFor(ability, { sourceLocale: "de", targetLocales: ["en"] });
    await ctrl.bulkTranslateLocale(ctx);
    await waitFor(jobs, ctx.body.jobId);
    const limited = { can: (_a, uid) => uid !== "api::secret.secret" };
    const getCtx = makeCtx({ params: { id: ctx.body.jobId }, state: { user: { id: 2 }, userAbility: limited } });
    await ctrl.getJob(getCtx);
    expect(getCtx.status).toBe(404);
    const listCtx = makeCtx({ state: { user: { id: 2 }, userAbility: limited } });
    await ctrl.listJobs(listCtx);
    expect(listCtx.body.jobs).toEqual([]);
  });
});

describe("translate controller — bulk translate into a locale (late drafts)", () => {
  it("leaves a draft created after queueing alone and lists only locales with work", async () => {
    const rows = { de: ["a1", "a2"], en: ["a1"], fr: ["a1", "a2"] };
    const calls = [];
    const strapi = makeStrapi({
      contentTypes: {
        "api::article.article": {
          kind: "collectionType",
          info: { displayName: "Article" },
          pluginOptions: { i18n: { localized: true } },
        },
      },
      documentsByUid: {
        "api::article.article": {
          async findMany({ locale }) {
            return (rows[locale] || []).map((documentId) => ({ documentId }));
          },
          async findOne({ documentId, locale }) {
            await new Promise((r) => setTimeout(r, 0));
            return (rows[locale] || []).includes(documentId) ? { documentId } : null;
          },
        },
      },
      fieldsDescribe: (uid) => ({
        uid,
        attributes: [{ name: "title", type: "string", directive: "translate" }],
      }),
      translateService: {
        async translateDocument(args) {
          calls.push(args.documentId);
          return { entry: { documentId: args.documentId, locale: args.targetLocale }, warnings: [] };
        },
      },
    });
    jobsFactory({ strapi: {} })._reset();
    const jobsSvc = jobsFactory({ strapi: { ...strapi, plugin: () => ({ config: { persistJobs: false } }) } });
    strapi.plugin = ((orig) => (id) => {
      const p = orig(id);
      return { ...p, service: (name) => (name === "jobs" ? jobsSvc : p.service(name)) };
    })(strapi.plugin);
    const ctrl = controllerFactory({ strapi });
    const ctx = makeCtx({ body: { sourceLocale: "de", targetLocales: ["en", "fr"] } });
    await ctrl.bulkTranslateLocale(ctx);
    expect(ctx.status).toBe(202);
    // An editor creates the English a2 draft before the job reaches it.
    rows.en.push("a2");
    let snap;
    for (let i = 0; i < 50; i++) {
      snap = jobsSvc.get(ctx.body.jobId);
      if (snap.state === "done") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls).toEqual([]);
    expect(snap.targets.map((t) => t.locale)).toEqual(["en"]);
    expect(snap.documents[0].targets[0].result.skipped).toBe(true);
  });
});
