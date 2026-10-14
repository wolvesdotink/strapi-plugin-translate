import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { initFixture, loadFixture } from "./fixture-app.mjs";

const directory = `/tmp/translate-integration-${process.pid}`;
await initFixture(directory);
process.env.STRAPI_TELEMETRY_DISABLED = "true";
const app = await loadFixture(directory);
const svc = (name) => app.plugin("translate").service(name);
const uid = "api::page.page";
try {
  const doc = await app
    .documents(uid)
    .findFirst({
      locale: "de",
      populate: svc("translatable-fields").buildPopulate(uid),
    });
  const originalTarget = await svc("changes").load(uid, doc.documentId, "en");
  const source = await svc("changes").load(uid, doc.documentId, "de");
  const data = {
    modules: source.modules.map((m, i) => ({
      id: m.id,
      __component: m.__component,
      title: i === 1 ? "Entdecke unsere neuesten Reisetipps" : m.title,
      description: m.description,
      ...(m.articles ? { articles: m.articles.map((a) => a.documentId) } : {}),
    })),
  };
  await app
    .documents(uid)
    .update({ documentId: doc.documentId, locale: "de", data });
  const changes = await svc("changes").get({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
  });
  assert.equal(changes.modules.length, 1);
  assert.equal(changes.modules[0].fields.length, 1);
  console.log("PASS source save captures one changed module/field");
  const provider = app.plugin("translate").provider;
  const providerTranslate = provider.translate.bind(provider);
  const calls = [];
  provider.translate = async (args) => {
    calls.push({ text: args.text, locale: args.targetLocale });
    return providerTranslate(args);
  };
  const preview = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "en",
    revision: changes.revision,
  });
  assert.deepEqual(calls, [
    { text: ["Entdecke unsere neuesten Reisetipps"], locale: "en" },
  ]);
  assert.equal(preview.modules.length, 1);
  assert.equal(
    preview.modules[0].fields[0].after,
    "Discover our latest travel tips",
  );
  assert.equal(preview.relations[0].targetLocale, "en");
  assert.equal(preview.relations[0].status, "draft-only");
  assert.equal(
    (await svc("changes").load(uid, doc.documentId, "en")).modules[1].title,
    originalTarget.modules[1].title,
  );
  const result = await svc("selective-preview").accept(preview.previewId);
  assert.equal(result.ok, true);
  const translated = await svc("changes").load(uid, doc.documentId, "en");
  assert.equal(translated.modules[1].title, "Discover our latest travel tips");
  assert.equal(
    translated.modules[1].description,
    originalTarget.modules[1].description,
  );
  assert.equal(
    translated.modules[0].description,
    originalTarget.modules[0].description,
  );
  assert.equal(translated.modules[0].id, originalTarget.modules[0].id);
  assert.equal(translated.modules[1].id, originalTarget.modules[1].id);
  assert.equal(translated.modules[1].articles[0].locale, "en");
  assert.equal(translated.publishedAt, null);
  assert.equal(
    (
      await svc("changes").get({
        uid,
        documentId: doc.documentId,
        sourceLocale: "de",
        targetLocale: "en",
      })
    ).modules.length,
    0,
  );
  assert.equal(
    (
      await svc("changes").get({
        uid,
        documentId: doc.documentId,
        sourceLocale: "de",
        targetLocale: "fr",
      })
    ).modules.length,
    1,
  );
  assert.deepEqual(
    await svc("selective-preview").accept(preview.previewId),
    result,
  );
  console.log(
    "PASS scoped apply preserves target IDs/manual content, links English, keeps French pending, and is idempotent",
  );
  const french = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "fr",
  });
  assert.equal(french.relations[0].status, "missing");
  await assert.rejects(
    svc("selective-preview").accept(french.previewId),
    /linked items/,
  );
  await svc("selective-preview").discard(french.previewId);
  assert.equal(
    (
      await svc("changes").get({
        uid,
        documentId: doc.documentId,
        sourceLocale: "de",
        targetLocale: "fr",
      })
    ).modules.length,
    1,
  );
  console.log(
    "PASS missing localized relations require explicit handling and discard keeps pending work",
  );
  app.getModel("blocks.featured").attributes.articles.required = true;
  const required = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "fr",
  });
  await assert.rejects(
    svc("selective-preview").accept(required.previewId, {
      allowMissingRelations: true,
    }),
    /linked items/,
  );
  delete app.getModel("blocks.featured").attributes.articles.required;
  console.log("PASS required missing locale relations cannot be omitted");
  const childPreview = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "fr",
    translateLinkedItems: true,
  });
  assert.equal(childPreview.children.length, 1);
  await svc("selective-preview").accept(childPreview.previewId);
  const fr = await svc("changes").load(uid, doc.documentId, "fr");
  assert.equal(fr.modules[1].articles[0].locale, "fr");
  console.log(
    "PASS explicit child translation creates French article before linking it",
  );

  // Source tracking is separate from the success of the editor's save.
  const state = svc("state");
  const write = state.write.bind(state);
  let failedOnce = false;
  state.write = async (key, ...args) => {
    if (key.startsWith("source:") && !failedOnce) {
      failedOnce = true;
      throw new Error("temporary metadata outage");
    }
    return write(key, ...args);
  };
  await app
    .documents(uid)
    .update({
      documentId: doc.documentId,
      locale: "de",
      data: { title: "Eine neue Seite" },
    });
  assert.equal(
    (await svc("changes").load(uid, doc.documentId, "de")).title,
    "Eine neue Seite",
  );
  state.write = write;
  assert.ok(
    (
      await svc("changes").get({
        uid,
        documentId: doc.documentId,
        sourceLocale: "de",
        targetLocale: "en",
      })
    ).modules.length,
  );
  console.log(
    "PASS a metadata failure preserves the source save and tracking can recover",
  );

  const first = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "en",
  });
  const second = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "en",
  });
  const concurrent = await Promise.allSettled([
    svc("selective-preview").accept(first.previewId),
    svc("selective-preview").accept(second.previewId),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((r) => r.status === "rejected").length, 1);
  console.log("PASS concurrent stale previews cannot overwrite one another");

  const conflict = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "fr",
  });
  await app
    .documents(uid)
    .update({
      documentId: doc.documentId,
      locale: "fr",
      data: { title: "A manual French edit" },
    });
  await assert.rejects(
    svc("selective-preview").accept(conflict.previewId),
    /target changed/,
  );
  assert.equal(
    (await svc("changes").load(uid, doc.documentId, "fr")).title,
    "A manual French edit",
  );
  const sourceConflict = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "fr",
  });
  await app
    .documents(uid)
    .update({
      documentId: doc.documentId,
      locale: "de",
      data: { title: "Noch eine Änderung" },
    });
  await assert.rejects(
    svc("selective-preview").accept(sourceConflict.previewId),
    /source changed/,
  );
  console.log("PASS source and target edits invalidate old previews");

  const settingsConflict = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "fr",
  });
  const settings = await svc("settings").get();
  await svc("settings").set({
    voice: "New voice",
    glossary: settings.glossary,
  });
  await assert.rejects(
    svc("selective-preview").accept(settingsConflict.previewId),
    /settings changed/,
  );
  console.log("PASS glossary/voice changes invalidate staged output");

  // The article was created in French, and its later source edits are an
  // explicit opt-in rather than an incidental whole-document retranslation.
  const articleId = doc.modules[1].articles[0].documentId;
  await app
    .documents("api::article.article")
    .update({
      documentId: articleId,
      locale: "de",
      data: { body: "Neue Tipps für deine Wanderung." },
    });
  const pageSource = await svc("changes").load(uid, doc.documentId, "de");
  await app
    .documents(uid)
    .update({
      documentId: doc.documentId,
      locale: "de",
      data: {
        modules: pageSource.modules.map((m, i) => ({
          id: m.id,
          __component: m.__component,
          title: i === 1 ? "Aktuelle Reisetipps" : m.title,
          description: m.description,
          ...(m.articles
            ? { articles: m.articles.map((a) => a.documentId) }
            : {}),
        })),
      },
    });
  const childUpdate = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "en",
    translateLinkedItems: true,
  });
  assert.equal(childUpdate.children.length, 1);
  assert.equal(childUpdate.children[0].modules[0].fields[0].name, "body");
  await svc("selective-preview").accept(childUpdate.previewId);
  const article = await svc("changes").load(
    "api::article.article",
    articleId,
    "en",
  );
  assert.equal(article.body, "New tips for your hike.");
  assert.equal(article.title, "Hiking in the Alps");
  console.log(
    "PASS explicit linked-item updates translate changed article fields and preserve its title",
  );

  const insertSource = await svc("changes").load(uid, doc.documentId, "de");
  const sourceModules = insertSource.modules.map((m) => ({
    id: m.id,
    __component: m.__component,
    title: m.title,
    description: m.description,
    ...(m.articles ? { articles: m.articles.map((a) => a.documentId) } : {}),
  }));
  sourceModules.splice(1, 0, {
    __component: "blocks.hero",
    title: "Ein neues Modul",
    description: "Neue Beschreibung",
  });
  await app
    .documents(uid)
    .update({
      documentId: doc.documentId,
      locale: "de",
      data: { modules: sourceModules },
    });
  const inserted = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "en",
  });
  assert.ok(
    inserted.modules.some((m) =>
      m.fields.some(
        (f) =>
          f.kind === "inserted-field" && f.after === "[en] Ein neues Modul",
      ),
    ),
  );
  await svc("selective-preview").accept(inserted.previewId);
  const targetInserted = await svc("changes").load(uid, doc.documentId, "en");
  assert.equal(targetInserted.modules.length, 3);
  assert.equal(targetInserted.modules[1].title, "[en] Ein neues Modul");
  assert.equal(
    targetInserted.modules[0].description,
    originalTarget.modules[0].description,
  );
  const moveSource = await svc("changes").load(uid, doc.documentId, "de");
  await app.documents(uid).update({
    documentId: doc.documentId,
    locale: "de",
    data: {
      modules: moveSource.modules
        .slice()
        .reverse()
        .map((m) => ({
          id: m.id,
          __component: m.__component,
          title: m.title,
          description: m.description,
          ...(m.articles
            ? { articles: m.articles.map((a) => a.documentId) }
            : {}),
        })),
    },
  });
  const moved = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "en",
  });
  await svc("selective-preview").accept(moved.previewId);
  const targetMoved = await svc("changes").load(uid, doc.documentId, "en");
  assert.deepEqual(
    targetMoved.modules.map((m) => m.id),
    targetInserted.modules
      .slice()
      .reverse()
      .map((m) => m.id),
  );
  const deleteSource = await svc("changes").load(uid, doc.documentId, "de");
  await app
    .documents(uid)
    .update({
      documentId: doc.documentId,
      locale: "de",
      data: {
        modules: deleteSource.modules
          .filter((_, i) => i !== 1)
          .map((m) => ({
            id: m.id,
            __component: m.__component,
            title: m.title,
            description: m.description,
            ...(m.articles
              ? { articles: m.articles.map((a) => a.documentId) }
              : {}),
          })),
      },
    });
  const removed = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "en",
  });
  await svc("selective-preview").accept(removed.previewId);
  assert.equal(
    (await svc("changes").load(uid, doc.documentId, "en")).modules.length,
    2,
  );
  console.log(
    "PASS real component insertion, reordering, and removal keep mapped target identity",
  );

  app.getModel(uid).attributes.title.maxLength = 30;
  provider.fixText = async ({ items }) => items.map(() => "Short title");
  await app
    .documents(uid)
    .update({
      documentId: doc.documentId,
      locale: "de",
      data: { title: "Ein sehr langer Seitentitel" },
    });
  const needsRepair = await svc("selective-preview").create({
    uid,
    documentId: doc.documentId,
    sourceLocale: "de",
    targetLocale: "en",
  });
  const beforeRepair = await svc("changes").load(uid, doc.documentId, "en");
  await assert.rejects(
    svc("selective-preview").accept(needsRepair.previewId),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(
        error.details.preview.modules[0].fields[0].after,
        "Short title",
      );
      return true;
    },
  );
  assert.equal(
    (await svc("changes").load(uid, doc.documentId, "en")).title,
    beforeRepair.title,
  );
  await svc("selective-preview").accept(needsRepair.previewId);
  assert.equal(
    (await svc("changes").load(uid, doc.documentId, "en")).title,
    "Short title",
  );
  delete app.getModel(uid).attributes.title.maxLength;
  console.log(
    "PASS validation repair stages revised text for review before saving it",
  );

  // New collection entries are tracked from their first save, so the editor
  // gets the same prompt as after an update of an existing entry.
  const articleUid = "api::article.article";
  const created = await app.documents(articleUid).create({
    locale: "de",
    data: { title: "Neue Hütte", body: "Ein Bett im Heu." },
  });
  const pendingKeys = async (targetLocale) =>
    (
      await svc("changes").get({
        uid: articleUid,
        documentId: created.documentId,
        sourceLocale: "de",
        targetLocale,
      })
    ).modules
      .map((m) => m.key)
      .sort();
  const fresh = await svc("changes").get({
    uid: articleUid,
    documentId: created.documentId,
    sourceLocale: "de",
  });
  // The empty `related` list is not new content.
  assert.deepEqual(fresh.modules.map((m) => m.key).sort(), [
    "root/body",
    "root/title",
  ]);
  const status = (changes) =>
    Object.fromEntries(
      changes.languages.map((l) => [l.locale, [l.exists, l.modules.length]]),
    );
  assert.deepEqual(status(fresh), { en: [false, 2], fr: [false, 2] });
  const initial = await svc("selective-preview").create({
    uid: articleUid,
    documentId: created.documentId,
    sourceLocale: "de",
    targetLocale: "en",
    revision: fresh.revision,
    initialTranslation: true,
  });
  await svc("selective-preview").accept(initial.previewId);
  assert.equal(
    (await svc("changes").load(articleUid, created.documentId, "en")).title,
    "[en] Neue Hütte",
  );
  assert.deepEqual(await pendingKeys("en"), []);
  // A language written by hand starts in sync with the source.
  await app.documents(articleUid).update({
    documentId: created.documentId,
    locale: "fr",
    data: { title: "Nouvelle cabane", body: "Un lit dans le foin." },
  });
  assert.deepEqual(await pendingKeys("fr"), []);
  await app.documents(articleUid).update({
    documentId: created.documentId,
    locale: "de",
    data: { body: "Zwei Betten im Heu." },
  });
  assert.deepEqual(await pendingKeys("en"), ["root/body"]);
  assert.deepEqual(await pendingKeys("fr"), ["root/body"]);
  assert.deepEqual(
    status(
      await svc("changes").get({
        uid: articleUid,
        documentId: created.documentId,
        sourceLocale: "de",
      }),
    ),
    { en: [true, 1], fr: [true, 1] },
  );
  console.log(
    "PASS new entries are tracked from creation, hand-written languages start in sync, and per-language status is reported",
  );

  // Existing automatic rules use the scoped engine and fire after the source
  // tracking transaction commits, without a duplicate interactive prompt.
  app.plugin("translate").config.autoTranslate = {
    enabled: true,
    rules: [{ uid, sourceLocale: "de", targetLocales: ["en"], on: "update" }],
  };
  svc("auto-translate").install();
  const beforeAuto = await svc("changes").load(uid, doc.documentId, "en");
  await app
    .documents(uid)
    .update({
      documentId: doc.documentId,
      locale: "de",
      data: { title: "Automatisch übersetzen" },
    });
  let automatic;
  for (let i = 0; i < 50; i++) {
    automatic = svc("jobs")
      .list()
      .filter((j) => j.source === "auto")
      .at(-1);
    if (automatic && ["done", "failed", "partial"].includes(automatic.state))
      break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(automatic?.state, "done", JSON.stringify(automatic));
  const afterAuto = await svc("changes").load(uid, doc.documentId, "en");
  assert.equal(afterAuto.title, "[en] Automatisch übersetzen");
  assert.equal(
    afterAuto.modules[0].description,
    beforeAuto.modules[0].description,
  );
  assert.equal(
    (
      await svc("changes").get({
        uid,
        documentId: doc.documentId,
        sourceLocale: "de",
        actingUserId: 1,
      })
    ).shouldPrompt,
    false,
  );
  // Update rules do not run on a new entry's first save, so its prompt stays.
  const createdPage = await app.requestContext.run(
    { state: { user: { id: 1 } } },
    () =>
      app.documents(uid).create({ locale: "de", data: { title: "Neu" } }),
  );
  assert.equal(
    (
      await svc("changes").get({
        uid,
        documentId: createdPage.documentId,
        sourceLocale: "de",
        actingUserId: 1,
      })
    ).shouldPrompt,
    true,
  );
  console.log(
    "PASS automatic propagation uses selective patches after commit and preserves manual module content",
  );
} finally {
  await app.destroy();
  await fs.rm(directory, { recursive: true, force: true });
}
