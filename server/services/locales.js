// Locale source-of-truth for the plugin.
//
// The plugin used to maintain its own hardcoded SUPPORTED_LOCALES set in two
// files; this service is the only place it lives now. We read locales from
// the i18n plugin at request time (so configured locales become "supported"
// without a code change) and memoize for the duration of an event-loop tick
// so a single request that hits us many times doesn't fan out queries.
//
// Fallback: if i18n isn't installed (e.g. in dev or a misconfigured install),
// we degrade to a small static list and log a warning rather than failing the
// plugin load. The plugin's own admin actions are useless without locales but
// the plugin should not block Strapi startup.

const FALLBACK_LOCALES = [
  { code: "en", name: "English", isDefault: false },
  { code: "de", name: "German", isDefault: true },
  { code: "fr", name: "French", isDefault: false },
  { code: "es", name: "Spanish", isDefault: false },
  { code: "it", name: "Italian", isDefault: false },
  { code: "nl", name: "Dutch", isDefault: false },
  { code: "pt", name: "Portuguese", isDefault: false },
  { code: "da", name: "Danish", isDefault: false },
];

/**
 * @typedef {{ code: string, name: string, isDefault?: boolean }} LocaleRecord
 * @typedef {{ codes: Set<string>, list: LocaleRecord[], fallback: boolean }} LocaleSnapshot
 */

export default ({ strapi }) => {
  let memo = null;
  let memoExpiresAt = 0;

  const fetchFresh = async () => {
    try {
      const i18n = strapi.plugin("i18n");
      const service = i18n && typeof i18n.service === "function" ? i18n.service("locales") : null;
      if (!service || typeof service.find !== "function") {
        strapi.log?.warn?.(
          "[translate] i18n plugin not available; falling back to static locale list"
        );
        return {
          list: FALLBACK_LOCALES.slice(),
          fallback: true,
        };
      }
      const list = await service.find();
      const cleaned = Array.isArray(list)
        ? list
            .filter((l) => l && typeof l.code === "string" && l.code)
            .map((l) => ({
              code: l.code,
              name: l.name || l.code,
              isDefault: !!l.isDefault,
            }))
        : [];
      if (cleaned.length === 0) {
        strapi.log?.warn?.(
          "[translate] i18n returned no locales; falling back to static list"
        );
        return { list: FALLBACK_LOCALES.slice(), fallback: true };
      }
      return { list: cleaned, fallback: false };
    } catch (err) {
      strapi.log?.warn?.(
        `[translate] failed to read locales from i18n (${err?.message || err}); using fallback`
      );
      return { list: FALLBACK_LOCALES.slice(), fallback: true };
    }
  };

  return {
    /**
     * @returns {Promise<LocaleSnapshot>}
     */
    async snapshot({ refresh = false } = {}) {
      const now = Date.now();
      if (!refresh && memo && now < memoExpiresAt) return memo;
      const { list, fallback } = await fetchFresh();
      memo = {
        list,
        codes: new Set(list.map((l) => l.code)),
        fallback,
      };
      // Short TTL — locales rarely change, but we want a request that
      // straddles a locale-add to pick up the new one without restart.
      memoExpiresAt = now + 5_000;
      return memo;
    },

    async codes() {
      return (await this.snapshot()).codes;
    },

    async list() {
      return (await this.snapshot()).list;
    },

    async has(code) {
      if (typeof code !== "string" || !code) return false;
      return (await this.codes()).has(code);
    },

    /** Force-clear the memo (used by tests; also called by settings.set). */
    invalidate() {
      memo = null;
      memoExpiresAt = 0;
    },
  };
};

export { FALLBACK_LOCALES };
