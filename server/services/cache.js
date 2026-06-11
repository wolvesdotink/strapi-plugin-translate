// Translation memory cache.
//
// Keyed by SHA-256 of (source-text, sourceLocale, targetLocale, format,
// voice, glossary-fingerprint). On a cache hit we skip the provider call
// entirely. Cache lives in strapi.store so it survives restarts.
//
// Eviction is a simple "drop oldest 500 when count > maxEntries". Not LRU —
// but fine here because the eviction trigger is rare and translation jobs
// rarely re-touch entries.

import crypto from "node:crypto";

const STORE_KEY = { type: "plugin", name: "translate", key: "cache" };

const DEFAULT_MAX_ENTRIES = 5000;
const EVICT_BATCH = 500;

const stableStringify = (obj) => {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
};

const fingerprintGlossary = (glossary) => {
  if (!glossary || typeof glossary !== "object") return "none";
  return crypto
    .createHash("sha256")
    .update(stableStringify(glossary))
    .digest("hex")
    .slice(0, 16);
};

/** @param {{ source: string, sourceLocale: any, targetLocale: any, format: any, voice: any, glossary: any, constraints?: any }} entry */
const hashEntry = ({ source, sourceLocale, targetLocale, format, voice, glossary, constraints }) => {
  const entry = {
    s: source,
    sl: sourceLocale,
    tl: targetLocale,
    f: format,
    v: voice || "",
    g: fingerprintGlossary(glossary),
  };
  // Schema constraints (e.g. maxLength) change what a valid translation is,
  // so they're part of the key — but only when present, so entries cached
  // before constraints existed keep their hashes.
  if (constraints && Object.keys(constraints).length > 0) {
    entry.c = constraints;
  }
  return crypto.createHash("sha256").update(stableStringify(entry)).digest("hex");
};

const isCacheEnabled = (strapi) => {
  const cfg = strapi.plugin("translate")?.config || {};
  if (cfg.cache && cfg.cache.enabled === false) return false;
  return true;
};

const maxEntries = (strapi) => {
  const cfg = strapi.plugin("translate")?.config || {};
  return cfg.cacheMaxEntries || DEFAULT_MAX_ENTRIES;
};

const cacheService = ({ strapi }) => {
  const store = () => strapi.store(STORE_KEY);

  const readAll = async () => {
    const data = await store().get();
    if (data && typeof data === "object") return data;
    return {};
  };

  const writeAll = async (data) => {
    await store().set({ value: data });
  };

  const evict = (data, limit) => {
    const keys = Object.keys(data);
    if (keys.length <= limit) return data;
    // Sort by createdAt asc; drop the oldest EVICT_BATCH.
    keys.sort((a, b) => (data[a].createdAt || 0) - (data[b].createdAt || 0));
    const toDrop = Math.min(EVICT_BATCH, keys.length - limit + EVICT_BATCH);
    for (let i = 0; i < toDrop; i++) delete data[keys[i]];
    return data;
  };

  return {
    /**
     * Build the cache key for an item without hitting storage.
     */
    keyFor(entry) {
      return hashEntry(entry);
    },

    fingerprintGlossary,

    /**
     * Look up many entries at once. Returns an array of {hit, translation, key}
     * in the same order as the input items.
     *
     * @param {Array<{source: string, sourceLocale, targetLocale, format, voice, glossary}>} items
     */
    async getMany(items) {
      if (!isCacheEnabled(strapi)) {
        return items.map((it) => ({ key: hashEntry(it), hit: false }));
      }
      if (!Array.isArray(items) || items.length === 0) return [];
      const data = await readAll();
      return items.map((it) => {
        const key = hashEntry(it);
        const row = data[key];
        if (row && typeof row.translation === "string") {
          // Update hitCount lazily — we re-read/write only on next setMany.
          return { key, hit: true, translation: row.translation };
        }
        return { key, hit: false };
      });
    },

    /**
     * Persist a batch of translations.
     * @param {Array<{key: string, translation: string}>} writes
     */
    async setMany(writes) {
      if (!isCacheEnabled(strapi)) return;
      if (!Array.isArray(writes) || writes.length === 0) return;
      const data = await readAll();
      const now = Date.now();
      for (const w of writes) {
        if (!w || !w.key || typeof w.translation !== "string") continue;
        const existing = data[w.key];
        data[w.key] = {
          translation: w.translation,
          createdAt: existing?.createdAt || now,
          hitCount: (existing?.hitCount || 0) + 1,
        };
      }
      const trimmed = evict(data, maxEntries(strapi));
      await writeAll(trimmed);
    },

    /**
     * Remove all cached entries. Returns the count cleared.
     */
    async clear() {
      const data = await readAll();
      const n = Object.keys(data).length;
      await writeAll({});
      return n;
    },

    /**
     * Cheap stats for the admin UI.
     */
    async stats() {
      const data = await readAll();
      const entries = Object.values(data);
      let oldest = null;
      let newest = null;
      let totalHits = 0;
      for (const e of entries) {
        if (!oldest || (e.createdAt || 0) < oldest) oldest = e.createdAt;
        if (!newest || (e.createdAt || 0) > newest) newest = e.createdAt;
        totalHits += e.hitCount || 0;
      }
      return {
        size: entries.length,
        oldest,
        newest,
        totalHits,
        enabled: isCacheEnabled(strapi),
        max: maxEntries(strapi),
      };
    },
  };
};

// Attach the pure helpers to the factory so callers that hold the default
// export (e.g. cache.test.js) can reach them as properties, matching the
// prior CJS `module.exports.hashEntry` behavior.
cacheService.hashEntry = hashEntry;
cacheService.fingerprintGlossary = fingerprintGlossary;

export default cacheService;

export { hashEntry, fingerprintGlossary };
