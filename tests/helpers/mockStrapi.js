"use strict";

// Minimal Strapi mock for unit tests. Each helper composes the bits a given
// service needs — keep it small. Tests can override any branch by passing
// `overrides` to `createStrapi()`.

const noop = () => {};

const makeLogger = () => ({
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
});

const makeStore = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  const keyOf = (descriptor) => `${descriptor.type}::${descriptor.name}::${descriptor.key}`;
  return (descriptor) => ({
    async get() {
      return data.get(keyOf(descriptor));
    },
    async set({ value }) {
      data.set(keyOf(descriptor), value);
      return value;
    },
    async delete() {
      data.delete(keyOf(descriptor));
    },
    _raw: data,
  });
};

const makeDocuments = (entries = {}) => {
  // entries shape:
  //   { "api::page.page": { [documentId]: { [locale]: {...entry} } } }
  const upserts = [];
  return (uid) => ({
    async findOne({ documentId, locale }) {
      return entries[uid]?.[documentId]?.[locale] || null;
    },
    async update({ documentId, locale, data }) {
      upserts.push({ uid, documentId, locale, data });
      if (!entries[uid]) entries[uid] = {};
      if (!entries[uid][documentId]) entries[uid][documentId] = {};
      const merged = { ...entries[uid][documentId][locale], ...data, documentId, locale };
      entries[uid][documentId][locale] = merged;
      return merged;
    },
    async findMany({ locale } = {}) {
      const all = [];
      for (const [docId, locales] of Object.entries(entries[uid] || {})) {
        if (locale && locales[locale]) all.push(locales[locale]);
        else if (!locale) all.push(...Object.values(locales));
      }
      return all;
    },
    _upserts: upserts,
  });
};

/**
 * Build a Strapi-like object usable by services in this plugin.
 *
 * @param {object} [overrides]
 * @param {object} [overrides.models]      uid -> schema { kind, attributes }
 * @param {object} [overrides.plugins]     pluginId -> { service, provider, config, defaults }
 * @param {object} [overrides.documents]   initial { uid: { documentId: { locale: data } } }
 * @param {object} [overrides.dbQueryFns]  uid -> findMany impl (for stale-relation preflight)
 * @param {object} [overrides.store]       initial store data
 * @param {object} [overrides.i18nLocales] locales for the i18n plugin service mock
 */
const createStrapi = (overrides = {}) => {
  const models = overrides.models || {};
  const dbQueryFns = overrides.dbQueryFns || {};
  const documents = makeDocuments(overrides.documents || {});
  const store = makeStore(overrides.store || {});

  const builtInPlugins = {
    i18n: {
      service: (name) => {
        if (name !== "locales") throw new Error(`unexpected i18n service: ${name}`);
        return {
          async find() {
            return overrides.i18nLocales || [
              { code: "de", name: "German", isDefault: true },
              { code: "en", name: "English", isDefault: false },
              { code: "fr", name: "French", isDefault: false },
            ];
          },
        };
      },
    },
  };

  const userPlugins = overrides.plugins || {};
  const pluginRegistry = { ...builtInPlugins, ...userPlugins };

  const strapi = {
    log: makeLogger(),
    config: {
      get: (key) => overrides.config?.[key],
    },
    getModel: (uid) => models[uid],
    db: {
      query: (uid) => ({
        async findMany(args) {
          const fn = dbQueryFns[uid];
          if (typeof fn === "function") return fn(args);
          return [];
        },
      }),
    },
    documents,
    store,
    plugin: (id) => pluginRegistry[id] || {},
    requestContext: { get: () => overrides.requestContext || {} },
    dirs: { app: { root: "/tmp/strapi-test" } },
  };

  if (overrides.includeRealLogger) strapi.log = console;

  return strapi;
};

/**
 * Build a plugin namespace ({service, provider, config, defaults}) using a
 * service map. Service keys are the same names registered in server/index.js.
 *
 * @param {object} init - { strapi, services?: {name: factory}, provider?, config?, defaults? }
 */
const installPlugin = (init) => {
  const { strapi } = init;
  const services = init.services || {};
  const instances = {};
  const ns = {
    provider: init.provider,
    config: init.config || {},
    defaults: init.defaults || { voice: "", glossary: { preserveExact: [], perLocale: {} } },
    service: (name) => {
      if (instances[name]) return instances[name];
      const factory = services[name];
      if (typeof factory !== "function") {
        throw new Error(`mockStrapi: service '${name}' not provided`);
      }
      instances[name] = factory({ strapi });
      return instances[name];
    },
  };
  // Hook into strapi.plugin("translate")
  strapi.plugin = (id) => {
    if (id === "translate") return ns;
    if (id === "i18n") {
      return {
        service: (n) => {
          if (n !== "locales") throw new Error(`unexpected i18n service: ${n}`);
          return {
            async find() {
              return init.i18nLocales || [
                { code: "de", name: "German", isDefault: true },
                { code: "en", name: "English", isDefault: false },
                { code: "fr", name: "French", isDefault: false },
              ];
            },
          };
        },
      };
    }
    return {};
  };
  return ns;
};

module.exports = { createStrapi, installPlugin };
