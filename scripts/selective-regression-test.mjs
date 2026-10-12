import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { initFixture, loadFixture } from "./fixture-app.mjs";
const dir = `/tmp/translate-regressions-${process.pid}`;
await initFixture(dir);
const schemaPath = `${dir}/src/api/page/content-types/page/schema.json`;
const schema = JSON.parse(await fs.readFile(schemaPath));
schema.attributes.modules.components.push("blocks.container");
await fs.writeFile(schemaPath, JSON.stringify(schema));
await fs.writeFile(
  `${dir}/src/components/blocks/container.json`,
  JSON.stringify({
    collectionName: "components_containers",
    info: { displayName: "Container" },
    attributes: {
      children: {
        type: "component",
        repeatable: true,
        component: "blocks.hero",
      },
    },
  }),
);
const heroPath = `${dir}/src/components/blocks/hero.json`;
const hero = JSON.parse(await fs.readFile(heroPath));
hero.attributes.translationKey = {
  type: "string",
  pluginOptions: { translate: { translate: "copy" } },
};
await fs.writeFile(heroPath, JSON.stringify(hero));
process.env.STRAPI_TELEMETRY_DISABLED = "true";
const app = await loadFixture(dir);
const svc = (name) => app.plugin("translate").service(name);
const uid = "api::page.page";
const controller = app.plugin("translate").controller("translate");
const user = await app.db
  .query("admin::user")
  .findOne({ where: { email: "translate-fixture@example.test" } });
const permissions = (readLocales, createLocales) =>
  ["read", "update", "create"].flatMap((action) =>
    [uid, "api::article.article"].map((subject) => ({
      action: `plugin::content-manager.explorer.${action}`,
      subject,
      properties: {
        fields: subject === uid ? ["title", "modules"] : ["title", "body"],
        locales:
          action === "read"
            ? readLocales
            : action === "create"
              ? createLocales
              : ["de", "en", "fr"],
      },
      conditions: [],
    })),
  );
const ability = async (read, create) =>
  app
    .service("admin::permission")
    .engine.generateTokenAbility(permissions(read, create), { roles: [] });
const ctxFor = (body, userAbility, id) => ({
  request: { body },
  state: { user, userAbility },
  params: { id },
  badRequest(message) {
    this.status = 400;
    this.body = { error: { message } };
  },
  notFound(message) {
    this.status = 404;
    this.body = { error: { message } };
  },
});
const stage = async (body, userAbility) => {
  const ctx = ctxFor(body, userAbility);
  await controller.createSelectivePreview(ctx);
  for (let i = 0; i < 100; i++) {
    const job = svc("jobs").get(ctx.body.jobId);
    if (["done", "partial", "failed", "cancelled"].includes(job.state))
      return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Preview job timed out: ${ctx.body.jobId}`);
};
try {
  const doc = await app.documents(uid).findFirst({ locale: "de" });
  const documentId = doc.documentId;
  await app
    .documents(uid)
    .update({ documentId, locale: "de", data: { title: "Edited source" } });

  // Missing-locale creation must obey locale and editable-field permissions.
  await app.documents(uid).delete({ documentId, locale: "fr" });
  const deniedCreate = await ability(["de", "en", "fr"], ["en"]);
  const denied = await stage(
    {
      uid,
      documentId,
      sourceLocale: "de",
      targetLocales: ["fr"],
      initialTranslation: true,
    },
    deniedCreate,
  );
  assert.equal(denied.state, "failed");
  assert.equal(denied.targets[0].result.status, 403);
  assert.equal(await svc("changes").load(uid, documentId, "fr"), null);
  const allowed = await ability(["de", "en", "fr"], ["en", "fr"]);
  const checker = app
    .plugin("content-manager")
    .service("permission-checker")
    .create({ userAbility: allowed, model: uid });
  assert.equal(checker.can.create({ locale: "fr" }), true);
  const created = await stage(
    {
      uid,
      documentId,
      sourceLocale: "de",
      targetLocales: ["fr"],
      initialTranslation: true,
    },
    allowed,
  );
  assert.equal(created.state, "done", JSON.stringify(created));
  const accept = ctxFor(
    { allowMissingRelations: true },
    allowed,
    created.targets[0].result.previewId,
  );
  await controller.acceptPreview(accept);
  assert.equal(accept.status || 200, 200, JSON.stringify(accept.body));
  const saved = await svc("changes").load(uid, documentId, "fr");
  assert.ok(saved);
  assert.equal(saved.title, "[fr] Edited source");
  assert.notEqual(saved.createdAt, doc.createdAt);
  console.log(
    "PASS permitted editors can create initial translations; denied locales stay blocked",
  );

  // Neither preview generation nor reading an existing preview may leak targets.
  const unrestricted = await stage(
    { uid, documentId, sourceLocale: "de", targetLocales: ["en"] },
    allowed,
  );
  assert.equal(unrestricted.state, "done", JSON.stringify(unrestricted));
  const restrictedRead = await ability(["de"], ["en"]);
  const target = await svc("changes").load(uid, documentId, "en");
  const readChecker = app
    .plugin("content-manager")
    .service("permission-checker")
    .create({ userAbility: restrictedRead, model: uid });
  assert.equal(readChecker.can.read(target), false);
  const blocked = await stage(
    { uid, documentId, sourceLocale: "de", targetLocales: ["en"] },
    restrictedRead,
  );
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.targets[0].result.status, 403);
  const privatePreview = unrestricted.targets[0].result.previewId;
  const get = ctxFor({}, restrictedRead, privatePreview);
  await controller.getPreview(get);
  assert.equal(get.status, 403);
  assert.ok(!JSON.stringify(get.body).includes("Travel guide"));
  const getJob = ctxFor({}, restrictedRead, unrestricted.id);
  await controller.getJob(getJob);
  assert.equal(getJob.status, 404);
  assert.ok(!JSON.stringify(getJob.body).includes("Travel guide"));
  const acceptDenied = ctxFor({}, restrictedRead, privatePreview);
  await controller.acceptPreview(acceptDenied);
  assert.equal(acceptDenied.status, 403);
  assert.equal(
    (await svc("changes").load(uid, documentId, "en")).title,
    target.title,
  );

  const fieldPermissions = permissions(["de", "en"], ["en"]);
  const readRule = fieldPermissions.find(
    (p) => p.subject === uid && p.action.endsWith(".read"),
  );
  readRule.properties.locales = ["de"];
  fieldPermissions.push({
    ...readRule,
    properties: { fields: ["modules"], locales: ["en"] },
  });
  const restrictedField = await app
    .service("admin::permission")
    .engine.generateTokenAbility(fieldPermissions, { roles: [] });
  const fieldChecker = app
    .plugin("content-manager")
    .service("permission-checker")
    .create({ userAbility: restrictedField, model: uid });
  assert.equal(fieldChecker.can.read(target), true);
  assert.equal(fieldChecker.can.read(target, "title"), false);
  const getField = ctxFor({}, restrictedField, privatePreview);
  await controller.getPreview(getField);
  assert.equal(getField.status, 403);
  const fieldStage = await stage(
    { uid, documentId, sourceLocale: "de", targetLocales: ["en"] },
    restrictedField,
  );
  assert.equal(fieldStage.targets[0].result.status, 403);
  await svc("selective-preview").discard(privatePreview, user.id);
  const discarded = ctxFor({}, restrictedRead, unrestricted.id);
  await controller.getJob(discarded);
  assert.equal(discarded.status, 404);
  assert.ok(!JSON.stringify(discarded.body).includes("Travel guide"));
  console.log(
    "PASS target locale/field read permissions are enforced on generation, retrieval, jobs, and acceptance",
  );

  // Moving an outer module must preserve independent ordering of its children.
  const nested = await app.documents(uid).create({
    locale: "de",
    data: {
      title: "Nested",
      modules: [
        {
          __component: "blocks.container",
          children: [
            { translationKey: "a", title: "A" },
            { translationKey: "b", title: "B" },
          ],
        },
        { __component: "blocks.hero", translationKey: "other", title: "Other" },
      ],
    },
  });
  await app.documents(uid).update({
    documentId: nested.documentId,
    locale: "en",
    data: {
      title: "Nested EN",
      modules: [
        {
          __component: "blocks.container",
          children: [
            { translationKey: "b", title: "Manual B" },
            { translationKey: "a", title: "Manual A" },
          ],
        },
        {
          __component: "blocks.hero",
          translationKey: "other",
          title: "Other EN",
        },
      ],
    },
  });
  const before = await svc("changes").load(uid, nested.documentId, "de");
  const write = (value) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([k]) =>
          ![
            "createdAt",
            "updatedAt",
            "documentId",
            "locale",
            "publishedAt",
          ].includes(k),
      ),
    );
  const modules = before.modules
    .map((m) => ({
      ...write(m),
      ...(m.children ? { children: m.children.map(write) } : {}),
    }))
    .reverse();
  await app
    .documents(uid)
    .update({ documentId: nested.documentId, locale: "de", data: { modules } });
  const args = {
    uid,
    documentId: nested.documentId,
    sourceLocale: "de",
    targetLocale: "en",
  };
  const move = await svc("selective-preview").create(args);
  await svc("selective-preview").accept(move.previewId);
  const movedTarget = await svc("changes").load(uid, nested.documentId, "en");
  assert.deepEqual(
    movedTarget.modules[1].children.map((c) => c.translationKey),
    ["b", "a"],
  );
  const movedSource = await svc("changes").load(uid, nested.documentId, "de");
  const nextModules = movedSource.modules.map((m) => ({
    ...write(m),
    ...(m.children ? { children: m.children.map(write) } : {}),
  }));
  nextModules[1].children[0].title = "Changed A";
  await app
    .documents(uid)
    .update({
      documentId: nested.documentId,
      locale: "de",
      data: { modules: nextModules },
    });
  const edit = await svc("selective-preview").create(args);
  await svc("selective-preview").accept(edit.previewId);
  const actual = await svc("changes").load(uid, nested.documentId, "en");
  assert.deepEqual(
    actual.modules[1].children.map((c) => ({
      key: c.translationKey,
      title: c.title,
    })),
    [
      { key: "b", title: "Manual B" },
      { key: "a", title: "[en] Changed A" },
    ],
  );
  console.log(
    "PASS moving an ancestor preserves nested target ordering and future translation identity",
  );

  // Optional missing relations on an approved child cannot be omitted.
  const related = await app
    .documents("api::article.article")
    .create({
      locale: "de",
      data: { title: "Second article", body: "Second" },
    });
  const article = await app
    .documents("api::article.article")
    .create({
      locale: "de",
      data: {
        title: "First article",
        body: "First",
        related: [related.documentId],
      },
    });
  const linkedPage = await app
    .documents(uid)
    .create({
      locale: "de",
      data: {
        title: "Linked",
        modules: [
          {
            __component: "blocks.featured",
            title: "Featured",
            articles: [article.documentId],
          },
        ],
      },
    });
  await app
    .documents(uid)
    .update({
      documentId: linkedPage.documentId,
      locale: "fr",
      data: {
        title: "Lié",
        modules: [
          {
            __component: "blocks.featured",
            title: "Featured FR",
            articles: [],
          },
        ],
      },
    });
  await app
    .documents(uid)
    .update({
      documentId: linkedPage.documentId,
      locale: "de",
      data: { title: "Linked changed" },
    });
  // Root title has no related refs; change the featured module instead.
  const pageSource = await svc("changes").load(
    uid,
    linkedPage.documentId,
    "de",
  );
  await app
    .documents(uid)
    .update({
      documentId: linkedPage.documentId,
      locale: "de",
      data: {
        modules: pageSource.modules.map((m) => ({
          id: m.id,
          __component: m.__component,
          title: "Featured changed",
          articles: [article.documentId],
        })),
      },
    });
  const linkedPreview = await svc("selective-preview").create({
    uid,
    documentId: linkedPage.documentId,
    sourceLocale: "de",
    targetLocale: "fr",
    translateLinkedItems: true,
  });
  assert.equal(linkedPreview.children[0].relations[0].status, "missing");
  assert.equal(linkedPreview.children[0].relations[0].required, false);
  await assert.rejects(
    svc("selective-preview").accept(linkedPreview.previewId, {
      allowMissingRelations: true,
    }),
    /Some linked items have no target-language version/,
  );
  assert.equal(
    await svc("changes").load("api::article.article", article.documentId, "fr"),
    null,
  );
  const childId = linkedPreview.children[0].previewId;
  // Required child links remain blocked even with explicit omission approval.
  app.getModel("api::article.article").attributes.related.required = true;
  await assert.rejects(
    svc("selective-preview").accept(linkedPreview.previewId, {
      childAllowMissingRelations: { [childId]: true },
    }),
    /Some linked items have no target-language version/,
  );
  assert.equal(
    await svc("changes").load("api::article.article", article.documentId, "fr"),
    null,
  );
  app.getModel("api::article.article").attributes.related.required = false;
  await svc("selective-preview").accept(linkedPreview.previewId, {
    childAllowMissingRelations: { [childId]: true },
  });
  const child = await svc("changes").load(
    "api::article.article",
    article.documentId,
    "fr",
  );
  assert.ok(child);
  assert.deepEqual(child.related, []);
  const linkedTarget = await svc("changes").load(
    uid,
    linkedPage.documentId,
    "fr",
  );
  assert.equal(
    linkedTarget.modules[0].articles[0].documentId,
    article.documentId,
  );
  assert.equal(linkedTarget.modules[0].articles[0].locale, "fr");
  console.log(
    "PASS optional child links need separate approval, required child links block, and failed acceptance rolls back",
  );
} finally {
  await app.destroy();
  await fs.rm(dir, { recursive: true, force: true });
}
