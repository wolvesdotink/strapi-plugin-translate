"use strict";

// User-editable plugin settings persisted in `strapi.store` so admins can
// tune voice/glossary at runtime without redeploying. The settings object
// merges:
//   - voice            : free-form tonality instruction injected into the
//                        translator's system prompt
//   - glossary.preserveExact
//                      : terms to keep verbatim across all locales (brand,
//                        place, product names)
//   - glossary.perLocale
//                      : per-target preferred mappings — e.g.
//                        { en: { "Motorhome Pitches": "Private Campsites" } }
//
// Defaults come from config/plugins.js (voice) and config/glossary.json
// (glossary). When no row exists in the store yet, get() seeds it from the
// defaults so the admin UI has something to edit.

const STORE_KEY = {
  type: "plugin",
  name: "translate",
  key: "settings",
};

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

const sanitizePreserveExact = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!isNonEmptyString(item)) continue;
    const trimmed = item.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const sanitizePerLocale = (perLocale, supportedCodes) => {
  if (!perLocale || typeof perLocale !== "object") return {};
  const out = {};
  for (const [locale, mappings] of Object.entries(perLocale)) {
    if (supportedCodes && !supportedCodes.includes(locale)) continue;
    if (!mappings || typeof mappings !== "object") continue;
    const cleaned = {};
    for (const [source, target] of Object.entries(mappings)) {
      if (!isNonEmptyString(source) || !isNonEmptyString(target)) continue;
      cleaned[source.trim()] = target.trim();
    }
    out[locale] = cleaned;
  }
  // Ensure every supported locale has at least an empty object so the UI
  // can render predictable rows.
  if (supportedCodes) {
    for (const code of supportedCodes) {
      if (!out[code]) out[code] = {};
    }
  }
  return out;
};

const sanitize = (raw, supportedCodes) => ({
  voice: isNonEmptyString(raw?.voice) ? raw.voice.trim() : "",
  glossary: {
    preserveExact: sanitizePreserveExact(raw?.glossary?.preserveExact),
    perLocale: sanitizePerLocale(raw?.glossary?.perLocale, supportedCodes),
  },
});

module.exports = ({ strapi }) => {
  const store = () => strapi.store(STORE_KEY);

  // Defaults snapshot taken at register-time and stashed on the plugin
  // namespace. See register.js — it stores `defaults` so we always have
  // something to seed/reset to without re-parsing files here.
  const defaults = () =>
    strapi.plugin("translate").defaults || {
      voice: "",
      glossary: { preserveExact: [], perLocale: {} },
    };

  const localesService = () => strapi.plugin("translate").service("locales");

  const supportedCodes = async () => {
    const svc = localesService();
    const list = await svc.list();
    return list.map((l) => l.code);
  };

  return {
    /**
     * Returns the effective settings — DB values if present, otherwise the
     * defaults seeded at register-time. Always sanitized.
     */
    async get() {
      const codes = await supportedCodes();
      const stored = await store().get();
      if (stored && typeof stored === "object") return sanitize(stored, codes);
      return sanitize(defaults(), codes);
    },

    /**
     * Replace the stored settings. Sanitized before write.
     */
    async set(payload) {
      const codes = await supportedCodes();
      const clean = sanitize(payload, codes);
      await store().set({ value: clean });
      return clean;
    },

    /**
     * Reset to the defaults captured at register-time.
     */
    async reset() {
      const codes = await supportedCodes();
      const clean = sanitize(defaults(), codes);
      await store().set({ value: clean });
      return clean;
    },

    async supportedLocales() {
      return supportedCodes();
    },
  };
};
