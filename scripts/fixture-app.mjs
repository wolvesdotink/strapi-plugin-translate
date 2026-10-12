// Disposable real Strapi app for integration checks and UI screenshots.
// npm run fixture -- init|build|start [directory] [plugin-directory]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureDir = path.resolve(
  process.env.TRANSLATE_FIXTURE_DIR || "/tmp/translate-strapi-fixture",
);
export async function initFixture(dir = fixtureDir, pluginDir = root) {
  const write = async (name, value) => {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(
      path.join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  };
  const text = {
    type: "string",
    pluginOptions: {
      i18n: { localized: true },
      translate: { translate: "translate" },
    },
  };
  await write("package.json", {
    name: "translate-fixture",
    version: "1.0.0",
    private: true,
    strapi: { uuid: "translate-fixture" },
    dependencies: {
      "@strapi/strapi": "5.48.0",
      "@strapi/i18n": "5.48.0",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
      "react-router-dom": "^6.30.4",
      "styled-components": "^6.4.2",
    },
  });
  await fs
    .symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"))
    .catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
  await write(
    "config/server.js",
    `module.exports = { host: '127.0.0.1', port: Number(process.env.TRANSLATE_FIXTURE_PORT || 1347), app: { keys: ['fixture-key-one', 'fixture-key-two'] } };`,
  );
  await write(
    "config/admin.js",
    `module.exports = { rateLimit: { enabled: false }, auth: { secret: 'fixture-admin-secret-do-not-use-in-production' }, apiToken: { salt: 'fixture-api-salt' }, transfer: { token: { salt: 'fixture-transfer-salt' } }, secrets: { encryptionKey: 'fixture-encryption-key' } };`,
  );
  await write(
    "config/database.js",
    `const path = require('node:path'); module.exports = { connection: { client: 'sqlite', connection: { filename: path.join(__dirname, '..', '.tmp', 'data.db') }, useNullAsDefault: true } };`,
  );
  await write(
    "config/plugins.js",
    `module.exports = { translate: { enabled: true, resolve: ${JSON.stringify(pluginDir)}, config: { providerOptions: { apiKey: 'fixture-only' }, settings: { sourceLocale: 'de' }, selectiveTranslation: { enabled: true, sourceLocales: ['de'] } } } };`,
  );
  await write(
    "config/middlewares.js",
    `module.exports = ['strapi::logger','strapi::errors','strapi::security','strapi::cors','strapi::poweredBy','strapi::query','strapi::body','strapi::session','strapi::favicon','strapi::public'];`,
  );
  await write("src/api/page/content-types/page/schema.json", {
    kind: "collectionType",
    collectionName: "pages",
    info: { singularName: "page", pluralName: "pages", displayName: "Page" },
    options: { draftAndPublish: true },
    pluginOptions: { i18n: { localized: true } },
    attributes: {
      title: text,
      modules: {
        type: "dynamiczone",
        components: ["blocks.hero", "blocks.featured"],
        pluginOptions: { i18n: { localized: true } },
      },
    },
  });
  await write("src/api/article/content-types/article/schema.json", {
    kind: "collectionType",
    collectionName: "articles",
    info: {
      singularName: "article",
      pluralName: "articles",
      displayName: "Article",
    },
    options: { draftAndPublish: true },
    pluginOptions: { i18n: { localized: true } },
    attributes: { title: text, body: { ...text, type: "text" } },
  });
  await write("src/components/blocks/hero.json", {
    collectionName: "components_heroes",
    info: { displayName: "Hero" },
    attributes: { title: text, description: { ...text, type: "text" } },
  });
  await write("src/components/blocks/featured.json", {
    collectionName: "components_featured",
    info: { displayName: "Featured articles" },
    attributes: {
      title: text,
      description: { ...text, type: "text" },
      articles: {
        type: "relation",
        relation: "oneToMany",
        target: "api::article.article",
        pluginOptions: { translate: { translate: "copy" } },
      },
    },
  });
  await write(
    "src/index.js",
    `module.exports = {
    async bootstrap({ strapi }) {
      const dictionary = { en: { 'Entdecke unsere neuesten Reisetipps': 'Discover our latest travel tips', 'Unsere Reisetipps': 'Our travel tips', 'Wandern in den Alpen': 'Hiking in the Alps', 'Neue Tipps für deine Wanderung.': 'New tips for your hike.' }, fr: { 'Entdecke unsere neuesten Reisetipps': 'Découvrez nos derniers conseils de voyage' } };
      strapi.plugin('translate').provider = {
        async translate({ text, targetLocale }) { await new Promise(r => setTimeout(r, 150)); return text.map(t => dictionary[targetLocale]?.[t] || '[' + targetLocale + '] ' + t); },
        async estimate() { return { inputTokens: 50, estimatedOutputTokens: 70, estimatedCostUsd: 0 }; },
        async usage() { return { count: 0, limit: 100 }; }
      };
      const localeService = strapi.plugin('i18n').service('locales');
      for (const [code, name] of [['de','German'],['fr','French']]) if (!(await localeService.find()).some(l => l.code === code)) await localeService.create({ code, name });
      if (!(await strapi.documents('api::page.page').findFirst({ locale: 'de' }))) {
        const article = await strapi.documents('api::article.article').create({ locale: 'de', data: { title: 'Wandern in den Alpen', body: 'Tipps für deine Wanderung.' } });
        await strapi.documents('api::article.article').update({ documentId: article.documentId, locale: 'en', data: { title: 'Hiking in the Alps', body: 'Tips for your hike.' } });
        const page = await strapi.documents('api::page.page').create({ locale: 'de', data: { title: 'Reiseführer', modules: [{ __component: 'blocks.hero', title: 'Willkommen in den Bergen', description: 'Plane dein nächstes Abenteuer.' }, { __component: 'blocks.featured', title: 'Unsere Reisetipps', description: 'Geschichten aus den Bergen.', articles: [article.documentId] }] } });
        for (const locale of ['en','fr']) await strapi.documents('api::page.page').update({ documentId: page.documentId, locale, data: { title: locale === 'en' ? 'Travel guide' : 'Guide de voyage', modules: [{ __component: 'blocks.hero', title: locale === 'en' ? 'Welcome to the mountains' : 'Bienvenue à la montagne', description: locale === 'en' ? 'An editor wrote this description.' : 'Une description rédigée par un éditeur.' }, { __component: 'blocks.featured', title: locale === 'en' ? 'Our travel tips' : 'Nos conseils de voyage', description: locale === 'en' ? 'An independently edited article intro.' : 'Des histoires de montagne.', articles: locale === 'en' ? [article.documentId] : [] }] } });
      }
      if (!(await strapi.db.query('admin::user').findOne({ where: { email: 'translate-fixture@example.test' } }))) {
        const role = await strapi.service('admin::role').getSuperAdmin();
        await strapi.service('admin::user').create({ firstname: 'Translation', lastname: 'Editor', email: 'translate-fixture@example.test', password: 'FixtureOnly123!', isActive: true, roles: [role.id] });
      }
    }
  };`,
  );
  await fs.writeFile(
    path.join(dir, "favicon.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await fs.mkdir(path.join(dir, ".tmp"), { recursive: true });
  await fs.mkdir(path.join(dir, "public/uploads"), { recursive: true });
  return dir;
}

export async function loadFixture(dir = fixtureDir) {
  process.chdir(dir);
  const require = createRequire(path.join(root, "package.json"));
  const { createStrapi } = require("@strapi/strapi");
  return createStrapi({ appDir: dir, distDir: dir }).load();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode = "init", directory = fixtureDir, pluginDirectory = root] =
    process.argv.slice(2);
  await initFixture(path.resolve(directory), path.resolve(pluginDirectory));
  if (mode === "build") {
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules/@strapi/strapi/bin/strapi.js"), "build"],
      {
        cwd: directory,
        stdio: "inherit",
        env: { ...process.env, STRAPI_TELEMETRY_DISABLED: "true" },
      },
    );
    child.on("exit", (code) => process.exit(code || 0));
  } else if (mode === "start") {
    const app = await loadFixture(path.resolve(directory));
    await app.start();
    const stop = async () => {
      await app.destroy();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }
}
