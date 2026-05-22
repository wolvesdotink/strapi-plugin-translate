"use strict";

/**
 * @typedef {object} RefRecord
 * @property {string} target  Strapi UID of the target table (e.g. "admin::user")
 * @property {string} idField "id" or "documentId" depending on target
 * @property {string|number} id
 * @property {string} label   For diagnostic warnings
 * @property {() => void} cleanup Strip this ref from the payload if stale
 *
 * @typedef {object} TranslationItem
 * @property {string} text
 * @property {Array<string|number>} path
 *
 * @typedef {object} BlocksItem
 * @property {Array<string|number>} path
 * @property {any} source
 * @property {Array<{ path: Array<string|number>, text: string }>} items
 *
 * @typedef {object} Bag
 * @property {TranslationItem[]} plain
 * @property {TranslationItem[]} html
 * @property {BlocksItem[]}     blocks
 * @property {RefRecord[]}      relations
 */

// Translate orchestrator. Mirrors the pattern of Fekide's strapi-plugin-translate
// but uses an LLM (via OpenRouter) instead of DeepL.
//
// Flow per single-document translate:
//   1. Fetch source entry deeply populated.
//   2. Walk the schema tree (CT → components → dynamic-zone items) collecting:
//        - plain strings
//        - HTML strings (richtext)
//        - blocks tree leaves
//        plus a "rebuild plan" that records where each translated value goes.
//   3. Group collected strings by format and call the provider in chunks.
//   4. Apply translations back into a deep-cloned data tree.
//   5. Upsert (create or update) the entry in the target locale.

const isPopulatedString = (v) => typeof v === "string" && v.trim().length > 0;

// System fields Strapi manages on entries/components. We strip these from
// copied component / dynamiczone payloads so Strapi treats them as fresh
// inserts for the target locale instead of trying to re-attach the source
// locale's row by stale `id` — which leaks numeric ids into document_id
// comparisons and triggers MySQL strict-mode type coercion errors.
const SYSTEM_KEYS = [
  "id",
  "documentId",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "locale",
  "createdBy",
  "updatedBy",
  "localizations",
];

const stripSystemKeys = (value) => {
  if (Array.isArray(value)) return value.map(stripSystemKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SYSTEM_KEYS.includes(k)) continue;
      out[k] = stripSystemKeys(v);
    }
    return out;
  }
  return value;
};

// Tiny path helpers — accept arrays of segments (so we don't have to escape
// dots or numeric indices). Mutates the target object.
const set = (obj, path, value) => {
  let cursor = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = path[i + 1];
    if (cursor[key] == null) {
      cursor[key] = typeof next === "number" ? [] : {};
    }
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
};

// Record a relation/media reference we plan to send to the upsert. Each ref
// carries a `cleanup` closure used by the preflight: if the referenced row
// has been deleted, cleanup strips this ref from the payload so the rest of
// the translation can still proceed (we surface the skipped refs as warnings
// to the user instead of aborting the job).
const recordRef = (bag, ref) => {
  if (ref.id == null) return;
  bag.relations.push(ref);
};

// Build cleanup closures for array vs singular ref slots. Captured `arr`
// reference is the same array that was set into `data`, so splicing it here
// mutates the payload in place.
const arrayRefCleanup = (arr, id) => () => {
  const idx = arr.indexOf(id);
  if (idx >= 0) arr.splice(idx, 1);
};
const singleRefCleanup = (data, refPath) => () => set(data, refPath, null);

// Walk a single attribute slot and collect text + record where to put the
// translation back. `bag.plain`, `bag.html`, `bag.blocks` collect work.
//
// pathPrefix is a lodash path into the *target* data tree we'll build.
const walkAttribute = ({
  strapi,
  attrDescriptor,
  value,
  pathPrefix,
  data,
  bag,
  fieldsService,
}) => {
  if (value == null) return;

  const { name, type, directive } = attrDescriptor;
  const labelPath = pathPrefix.concat(name).join(".");

  // Skip / copy: write the value through verbatim.
  if (directive === "skip" || directive === "copy") {
    if (type === "relation") {
      // For relations marked copy: connect by document id (Strapi v5 connect form)
      const target = attrDescriptor.target;
      // admin::user has no documentId — connect by numeric id instead.
      const idField = target === "admin::user" ? "id" : "documentId";
      if (Array.isArray(value)) {
        const ids = value.map((r) => r[idField]).filter(Boolean);
        set(data, pathPrefix.concat(name), ids);
        ids.forEach((id) =>
          recordRef(bag, {
            target,
            idField,
            id,
            label: labelPath,
            cleanup: arrayRefCleanup(ids, id),
          })
        );
      } else if (value && value[idField]) {
        const refPath = pathPrefix.concat(name);
        set(data, refPath, value[idField]);
        recordRef(bag, {
          target,
          idField,
          id: value[idField],
          label: labelPath,
          cleanup: singleRefCleanup(data, refPath),
        });
      }
      return;
    }
    if (type === "media") {
      // Media: connect by id
      if (Array.isArray(value)) {
        const ids = value.map((m) => m.id).filter(Boolean);
        set(data, pathPrefix.concat(name), ids);
        ids.forEach((id) =>
          recordRef(bag, {
            target: "plugin::upload.file",
            idField: "id",
            id,
            label: labelPath,
            cleanup: arrayRefCleanup(ids, id),
          })
        );
      } else if (value && value.id) {
        const refPath = pathPrefix.concat(name);
        set(data, refPath, value.id);
        recordRef(bag, {
          target: "plugin::upload.file",
          idField: "id",
          id: value.id,
          label: labelPath,
          cleanup: singleRefCleanup(data, refPath),
        });
      }
      return;
    }
    // Components, dynamiczones, and other structured values: strip the
    // source-locale system keys so Strapi inserts fresh rows for the
    // target locale instead of reattaching stale ids.
    set(data, pathPrefix.concat(name), stripSystemKeys(value));
    return;
  }

  if (directive === "delete") {
    set(data, pathPrefix.concat(name), null);
    return;
  }

  // Regenerate: don't set the field on the target payload at all. The
  // intent is for a lifecycle hook (e.g. slugify) to derive it freshly
  // from translated source-of-truth fields. Used for uid-typed fields.
  if (directive === "regenerate") return;

  if (directive !== "translate") return;

  // ---- translate ----
  const fullPath = pathPrefix.concat(name);

  if (type === "string" || type === "text") {
    if (!isPopulatedString(value)) {
      set(data, fullPath, value);
      return;
    }
    bag.plain.push({ text: value, path: fullPath });
    return;
  }

  if (type === "richtext") {
    if (!isPopulatedString(value)) {
      set(data, fullPath, value);
      return;
    }
    bag.html.push({ text: value, path: fullPath });
    return;
  }

  if (type === "blocks") {
    // Strapi native blocks JSON tree
    const formatService = strapi
      .plugin("translate")
      .service("format");
    const items = formatService.collectBlocksTexts(value);
    if (items.length === 0) {
      set(data, fullPath, value);
      return;
    }
    // Record blocks-leaf items together so we can reconstruct after.
    bag.blocks.push({ path: fullPath, source: value, items });
    return;
  }

  if (type === "component") {
    const componentUid = attrDescriptor.component;
    if (attrDescriptor.repeatable && Array.isArray(value)) {
      value.forEach((item, i) => {
        walkComponent({
          strapi,
          uid: componentUid,
          value: item,
          pathPrefix: fullPath.concat(i),
          data,
          bag,
          fieldsService,
        });
      });
    } else if (value) {
      walkComponent({
        strapi,
        uid: componentUid,
        value,
        pathPrefix: fullPath,
        data,
        bag,
        fieldsService,
      });
    }
    return;
  }

  if (type === "dynamiczone" && Array.isArray(value)) {
    // Each item identifies its component via __component
    value.forEach((item, i) => {
      if (!item || !item.__component) return;
      const componentUid = item.__component;
      // First write through __component itself + scalar fields
      set(data, fullPath.concat(i).concat("__component"), componentUid);
      walkComponent({
        strapi,
        uid: componentUid,
        value: item,
        pathPrefix: fullPath.concat(i),
        data,
        bag,
        fieldsService,
      });
    });
    return;
  }
};

const walkComponent = ({
  strapi,
  uid,
  value,
  pathPrefix,
  data,
  bag,
  fieldsService,
}) => {
  const { attributes } = fieldsService.describe(uid);
  for (const attr of attributes) {
    walkAttribute({
      strapi,
      attrDescriptor: attr,
      value: value ? value[attr.name] : undefined,
      pathPrefix,
      data,
      bag,
      fieldsService,
    });
  }
};

// Verify every relation/media reference we're about to send still exists.
// Returns the subset of refs whose target row was not found, so the caller
// can run their cleanup closures (which strip the stale ref from the
// payload) and report them as warnings instead of aborting the job.
//
// Cardinality is bounded: one query per *target table* (admin::user,
// plugin::upload.file, plus each CT that this entry's relations point to).
// We deliberately don't batch across tables because each FK lives on its
// own table; cross-table batching would require dynamic SQL or N round-trips
// either way. For a typical entry this is 2–4 queries.
const verifyRelations = async ({ strapi, refs }) => {
  if (refs.length === 0) return [];

  const byTarget = new Map();
  for (const ref of refs) {
    let group = byTarget.get(ref.target);
    if (!group) {
      group = { idField: ref.idField, ids: new Set() };
      byTarget.set(ref.target, group);
    }
    group.ids.add(ref.id);
  }

  const missingByTarget = new Map();
  for (const [target, { idField, ids }] of byTarget) {
    const found = await strapi.db.query(target).findMany({
      where: { [idField]: { $in: [...ids] } },
      select: [idField],
    });
    const foundIds = new Set(found.map((r) => r[idField]));
    const missing = new Set();
    for (const id of ids) {
      if (!foundIds.has(id)) missing.add(id);
    }
    if (missing.size > 0) missingByTarget.set(target, missing);
  }

  // Re-walk the original refs so every cleanup closure (e.g. createdBy AND
  // updatedBy stamps sharing one stale user id) is included in the result.
  return refs.filter((ref) => {
    const missing = missingByTarget.get(ref.target);
    return missing && missing.has(ref.id);
  });
};

// Apply chunked translations back into the data tree.
const applyTranslations = ({
  strapi,
  data,
  bag,
  plainTranslations,
  htmlTranslations,
  blocksTranslations,
}) => {
  // Plain
  bag.plain.forEach((item, i) => {
    set(data, item.path, plainTranslations[i]);
  });
  // HTML
  bag.html.forEach((item, i) => {
    set(data, item.path, htmlTranslations[i]);
  });
  // Blocks — each entry has its own list of leaf items
  let cursor = 0;
  const formatService = strapi.plugin("translate").service("format");
  bag.blocks.forEach((item) => {
    const slice = blocksTranslations.slice(cursor, cursor + item.items.length);
    cursor += item.items.length;
    const rebuilt = formatService.applyBlocksTexts(
      item.source,
      item.items,
      slice
    );
    set(data, item.path, rebuilt);
  });
};

module.exports = ({ strapi }) => {
  const fields = () => strapi.plugin("translate").service("translatable-fields");
  const chunks = () => strapi.plugin("translate").service("chunks");
  const settingsService = () => strapi.plugin("translate").service("settings");
  const cacheService = () => strapi.plugin("translate").service("cache");
  const provider = () => strapi.plugin("translate").provider;
  // Non-user-editable config (sourceLocale, chunking knobs).
  const config = () => strapi.plugin("translate").config || {};

  return {
    /**
     * Translate a single document from source -> target locale.
     * Returns the upserted target-locale entry.
     *
     * Optional kwargs:
     *   signal     — AbortSignal. If aborted mid-flight, in-flight provider
     *                requests are cancelled and no further chunks are scheduled.
     *                An AbortError is thrown before the target-locale upsert.
     *   onProgress — ({format, done, total}) => void. Called once per format
     *                with the initial total after chunking, then after each
     *                chunk completion with the running `done` count.
     */
    // Shared compute path: walks the source, runs the provider, applies
    // translations back, returns the proposed payload + stamping context.
    // Used by translateDocument (which then upserts), translateDocumentDry
    // (preview flow), and the back-translate sanity check.
    async _compute({
      uid,
      documentId,
      sourceLocale,
      targetLocale,
      actingUserId,
      signal,
      onProgress,
    }) {
      if (!uid) throw new Error("uid is required");
      if (!documentId) throw new Error("documentId is required");
      if (!sourceLocale) sourceLocale = config().sourceLocale;
      if (!targetLocale) throw new Error("targetLocale is required");
      if (sourceLocale === targetLocale) {
        throw new Error("source and target locale must differ");
      }

      const makeAbortError = () => {
        const e = new Error("[translate] aborted");
        e.name = "AbortError";
        return e;
      };
      const emit = (format, done, total) => {
        if (typeof onProgress === "function") {
          try {
            onProgress({ format, done, total });
          } catch {
            // never let a progress hook break the translation
          }
        }
      };

      // Resolve the acting admin user. Used to stamp createdBy/updatedBy on the
      // target-locale variant so Strapi's relation validator never trips on a
      // stale admin::user FK propagated by the i18n middleware.
      const resolvedActingUserId =
        actingUserId ||
        strapi.requestContext?.get?.()?.state?.user?.id ||
        null;

      const fieldsService = fields();

      // 1. Fetch source entry deeply populated
      const populate = fieldsService.buildPopulate(uid);
      const source = await strapi.documents(uid).findOne({
        documentId,
        locale: sourceLocale,
        populate,
        status: "draft",
      });
      if (!source) {
        throw new Error(
          `source entry not found: ${uid} ${documentId} (${sourceLocale})`
        );
      }

      // 2. Walk schema, collecting translation work into bag and writing
      //    pass-through values into `data`.
      const data = {};
      const bag = { plain: [], html: [], blocks: [], relations: [] };

      const ctDescriptor = fieldsService.describe(uid);
      for (const attr of ctDescriptor.attributes) {
        walkAttribute({
          strapi,
          attrDescriptor: attr,
          value: source[attr.name],
          pathPrefix: [],
          data,
          bag,
          fieldsService,
        });
      }

      // 2a. Preflight: verify every relation/media we're about to send still
      //     exists. Strapi's entity-validator runs this check at upsert time,
      //     but failing there means we've already burned LLM tokens. Doing it
      //     here surfaces stale FKs (e.g. a deleted admin user being stamped
      //     as createdBy/updatedBy) before any provider calls go out. Missing
      //     refs are stripped from the payload and reported as warnings so the
      //     rest of the translation can still proceed.
      const modelAttrs = strapi.getModel(uid)?.attributes || {};
      const stamping = { createdBy: false, updatedBy: false };
      if (resolvedActingUserId) {
        if (modelAttrs.createdBy) {
          stamping.createdBy = true;
          bag.relations.push({
            target: "admin::user",
            idField: "id",
            id: resolvedActingUserId,
            label: "createdBy (acting user stamp)",
            cleanup: () => {
              stamping.createdBy = false;
            },
          });
        }
        if (modelAttrs.updatedBy) {
          stamping.updatedBy = true;
          bag.relations.push({
            target: "admin::user",
            idField: "id",
            id: resolvedActingUserId,
            label: "updatedBy (acting user stamp)",
            cleanup: () => {
              stamping.updatedBy = false;
            },
          });
        }
      }
      const missingRefs = await verifyRelations({
        strapi,
        refs: bag.relations,
      });
      for (const ref of missingRefs) ref.cleanup();
      const warnings = missingRefs.map((r) => ({
        target: r.target,
        id: r.id,
        label: r.label,
      }));
      if (warnings.length > 0) {
        strapi.log.warn(
          `[translate] ${warnings.length} stale relation(s) skipped: ${warnings
            .map((w) => `${w.target}#${w.id} @ ${w.label}`)
            .join("; ")}`
        );
      }

      // 3. Translate each format group (chunked)
      const maxChars =
        config().maxInputCharsPerChunk || undefined;
      // Per-item chunking: each translatable field becomes its own LLM
      // request. Avoids `finish_reason=length` truncation on entries with
      // many translatable fields where batched output exceeds the model's
      // max_output_tokens. Defaults to true; opt out by setting
      // `perItemChunks: false` in plugin settings.
      const perItem = config().perItemChunks !== false;
      const maxConcurrency = config().maxConcurrentChunks || 10;
      const provFn = provider();

      // Live, admin-editable voice + glossary. Captured once per job so
      // every chunk for this translation uses a consistent prompt — but the
      // next job picks up any changes the admin saves in the meantime.
      const userSettings = await settingsService().get();

      const mapWithConcurrency = async (items, limit, fn) => {
        const results = new Array(items.length);
        let cursor = 0;
        const worker = async () => {
          while (cursor < items.length) {
            if (signal?.aborted) throw makeAbortError();
            const i = cursor++;
            results[i] = await fn(items[i], i);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(limit, items.length) }, worker)
        );
        return results;
      };

      // Translation memory cache. For each item, check the cache first; only
      // unseen strings are sent to the provider. The provider response is
      // written back to the cache. Glossary fingerprint is baked into the
      // cache key so editing the glossary invalidates the relevant entries.
      const cache = cacheService();
      const cacheKeyInputs = (text) =>
        text.map((source) => ({
          source,
          sourceLocale,
          targetLocale,
          format: null, // filled in per-group
          voice: userSettings.voice || "",
          glossary: userSettings.glossary,
        }));

      const translateGroup = async (items, format) => {
        if (items.length === 0) {
          emit(format, 0, 0);
          return [];
        }
        const sources = items.map((it) => it.text);
        // Lookup all sources in cache.
        const lookups = await cache.getMany(
          cacheKeyInputs(sources).map((k) => ({ ...k, format }))
        );
        const finalOut = new Array(sources.length);
        const missIdxs = [];
        const missTexts = [];
        for (let i = 0; i < sources.length; i++) {
          if (lookups[i].hit) {
            finalOut[i] = lookups[i].translation;
          } else {
            missIdxs.push(i);
            missTexts.push(sources[i]);
          }
        }

        if (missTexts.length === 0) {
          // Whole group served from cache — emit a single completed chunk.
          emit(format, 1, 1);
          return finalOut;
        }

        const groups = chunks().chunk(missTexts, { maxChars, perItem });
        const total = groups.length;
        let done = 0;
        emit(format, 0, total);

        // Track which (group, withinGroupIdx) maps to which original index
        // so cache writes can pair (source -> translation).
        const groupOriginIdx = []; // groupOriginIdx[g][i] = miss index
        let cursor = 0;
        for (const g of groups) {
          const arr = [];
          for (let i = 0; i < g.length; i++) arr.push(cursor++);
          groupOriginIdx.push(arr);
        }

        const translatedChunks = await mapWithConcurrency(
          groups,
          maxConcurrency,
          async (group, gi) => {
            const out = await provFn.translate({
              text: group,
              sourceLocale,
              targetLocale,
              format,
              signal,
              voice: userSettings.voice,
              glossary: userSettings.glossary,
            });
            // Persist cache writes for this chunk.
            const writes = [];
            for (let i = 0; i < group.length; i++) {
              const originIdx = groupOriginIdx[gi][i];
              const cacheKey = cache.keyFor({
                source: group[i],
                sourceLocale,
                targetLocale,
                format,
                voice: userSettings.voice || "",
                glossary: userSettings.glossary,
              });
              writes.push({ key: cacheKey, translation: out[i] });
              finalOut[missIdxs[originIdx]] = out[i];
            }
            // Fire-and-forget the cache write; failure shouldn't fail the job.
            cache.setMany(writes).catch((err) => {
              strapi.log?.warn?.(
                `[translate] cache write failed: ${err?.message || err}`
              );
            });
            done += 1;
            emit(format, done, total);
            return out;
          }
        );
        // translatedChunks is consumed via finalOut; the value is intentionally
        // ignored — finalOut already has the assembly.
        void translatedChunks;
        return finalOut;
      };

      const blocksFlat = bag.blocks.flatMap((b) => b.items);
      const [plainTranslations, htmlTranslations, blocksTranslations] =
        await Promise.all([
          translateGroup(bag.plain, "plain"),
          translateGroup(bag.html, "html"),
          translateGroup(blocksFlat, "blocks"),
        ]);

      // If we were aborted between the provider returning and us reaching
      // the upsert step, bail out before mutating the database.
      if (signal?.aborted) throw makeAbortError();

      // Optional sanity-check sample (consumed only when args.sanityCheck is
      // truthy in translateDocument). We pick a few longest pairs per format
      // so the check has enough signal to detect drift.
      const sanityPairs = [];
      const pickTop = (items, translations, format, limit) => {
        const arr = items
          .map((it, i) => ({
            original: it.text,
            translated: translations[i],
            format,
            label: Array.isArray(it.path) ? it.path.join(".") : undefined,
          }))
          .sort((a, b) => (b.original || "").length - (a.original || "").length);
        for (let i = 0; i < Math.min(arr.length, limit); i++) sanityPairs.push(arr[i]);
      };
      pickTop(bag.plain, plainTranslations, "plain", 5);
      pickTop(bag.html, htmlTranslations, "html", 5);
      pickTop(blocksFlat, blocksTranslations, "blocks", 5);

      // 4. Apply translations back
      applyTranslations({
        strapi,
        data,
        bag,
        plainTranslations,
        htmlTranslations,
        blocksTranslations,
      });

      // Note: uid-typed fields with directive=translate are coerced to
      // "regenerate" by translatable-fields.js, and the walker skips them
      // (no value written into `data`). That lets the slugify lifecycle
      // derive a fresh slug from the translated title for the target locale.
      // Previously this was a hardcoded `delete data.slug;` — replaced by
      // the explicit directive.

      return {
        proposed: data,
        warnings,
        stamping,
        modelAttrs,
        resolvedActingUserId,
        uid,
        documentId,
        targetLocale,
        _sanityPairs: sanityPairs,
      };
    },

    /**
     * Translate a single document from source -> target locale.
     * Returns the upserted target-locale entry.
     *
     * Optional args:
     *   sanityCheck — when truthy, after the forward pass we back-translate
     *     a sample of strings and surface any low-similarity items as
     *     warnings. Doubles cost on the sampled subset; off by default.
     */
    async translateDocument(args) {
      const computed = await this._compute(args);
      let warnings = computed.warnings.slice();
      if (args && args.sanityCheck) {
        try {
          const sanity = await this._runSanityCheck({
            computed,
            sourceLocale: args.sourceLocale || config().sourceLocale,
            targetLocale: args.targetLocale,
          });
          for (const w of sanity.warnings) {
            warnings.push({ kind: "sanity", ...w });
          }
        } catch (err) {
          strapi.log?.warn?.(
            `[translate] sanity check failed (continuing): ${err?.message || err}`
          );
        }
      }
      const entry = await this.commitPreview(computed);
      return { entry, warnings };
    },

    async _runSanityCheck({ computed, sourceLocale, targetLocale }) {
      const backTranslate = strapi.plugin("translate").service("back-translate");
      if (!backTranslate) return { warnings: [] };
      const userSettings = await settingsService().get();
      // Pair (original source text, translated text). We sample from the bag.
      // _compute returns proposed but not the bag — to keep this self-contained
      // we re-walk the source. Instead, take the bag from _compute by chaining
      // it via the optional `_bag` field, populated below.
      const pairs = (computed._sanityPairs || []).slice(0, 30);
      if (pairs.length === 0) return { warnings: [] };
      return backTranslate.check({
        pairs,
        sourceLocale,
        targetLocale,
        voice: userSettings.voice,
        glossary: userSettings.glossary,
      });
    },

    /**
     * Translate but do not commit. Used by the preview/review flow.
     */
    async translateDocumentDry(args) {
      const computed = await this._compute(args);
      return computed;
    },

    /**
     * Apply a pre-computed proposed payload to the target locale entry.
     * Handles the create-via-update fallback Strapi v5 needs to assign a
     * locale to an existing document.
     *
     * @param {object} args
     * @param {string} args.uid
     * @param {string} args.documentId
     * @param {string} args.targetLocale
     * @param {object} [args.proposed]
     * @param {object} [args.stamping]
     * @param {object} [args.modelAttrs]
     * @param {string|number} [args.resolvedActingUserId]
     * @param {string|number} [args.actingUserId]
     */
    async commitPreview({
      uid,
      documentId,
      targetLocale,
      proposed,
      stamping,
      modelAttrs,
      resolvedActingUserId,
      actingUserId,
    }) {
      const data = { ...(proposed || {}) };
      const resolvedAttrs = modelAttrs || strapi.getModel(uid)?.attributes || {};
      const resolvedStamping = stamping || { createdBy: !!actingUserId, updatedBy: !!actingUserId };
      const resolvedUserId = resolvedActingUserId || actingUserId || null;

      const existing = await strapi.documents(uid).findOne({
        documentId,
        locale: targetLocale,
        status: "draft",
      });

      // `stamping.*` flags are flipped off by preflight cleanup when the
      // acting user no longer exists — so we only stamp users we verified.
      if (existing) {
        // UPDATE: refresh updatedBy, clear stale assignee, preserve createdBy.
        if (resolvedStamping.updatedBy && resolvedUserId) {
          data.updatedBy = resolvedUserId;
        }
        if (resolvedAttrs.strapi_assignee) {
          data.strapi_assignee = null;
        }
        return strapi.documents(uid).update({
          documentId,
          locale: targetLocale,
          data,
        });
      }

      // CREATE-via-UPDATE: stamp creator + updater, clear assignee.
      //
      // Strapi v5's `documents().create({ documentId, ... })` silently
      // discards the `documentId` parameter and inserts a fresh document
      // (see node_modules/@strapi/core/.../repository.mjs `create()` — it
      // destructures documentId out of opts and never passes it through).
      //
      // The canonical "add a new locale to an existing document" pattern is
      // `update()`. When no entry exists for (documentId, locale), the
      // update() implementation falls through to copyNonLocalizedFields()
      // + entries.create() with the original documentId preserved, which
      // is exactly what we want.
      if (resolvedStamping.createdBy && resolvedUserId) data.createdBy = resolvedUserId;
      if (resolvedStamping.updatedBy && resolvedUserId) data.updatedBy = resolvedUserId;
      if (resolvedAttrs.strapi_assignee) {
        data.strapi_assignee = null;
      }
      return strapi.documents(uid).update({
        documentId,
        locale: targetLocale,
        data,
      });
    },

    // Light helper for the controller — returns plugin usage from the provider
    async usage() {
      return provider().usage();
    },

    /**
     * Cost estimate for a translation job. Walks the schema like
     * translateDocument(), collects strings, subtracts cached entries, then
     * calls provider.estimate() per format group. Multiplied by the number
     * of target locales (each locale is an independent provider call).
     */
    async estimate({ uid, documentId, sourceLocale, targetLocales }) {
      if (!uid) throw new Error("uid is required");
      if (!documentId) throw new Error("documentId is required");
      const src = sourceLocale || config().sourceLocale;
      const targets = Array.isArray(targetLocales) ? targetLocales : [];
      if (targets.length === 0) {
        throw new Error("targetLocales is required");
      }

      const fieldsService = fields();
      const populate = fieldsService.buildPopulate(uid);
      const source = await strapi.documents(uid).findOne({
        documentId,
        locale: src,
        populate,
        status: "draft",
      });
      if (!source) {
        throw new Error(
          `source entry not found: ${uid} ${documentId} (${src})`
        );
      }

      const data = {};
      const bag = { plain: [], html: [], blocks: [], relations: [] };
      const ctDescriptor = fieldsService.describe(uid);
      for (const attr of ctDescriptor.attributes) {
        walkAttribute({
          strapi,
          attrDescriptor: attr,
          value: source[attr.name],
          pathPrefix: [],
          data,
          bag,
          fieldsService,
        });
      }

      const userSettings = await settingsService().get();
      const cache = cacheService();
      const provFn = provider();

      const estimateGroup = async (items, format) => {
        if (items.length === 0) {
          return { sent: 0, cached: 0, inputTokens: 0, estimatedOutputTokens: 0, estimatedCostUsd: 0 };
        }
        const sources = items.map((it) => it.text);
        const lookups = await cache.getMany(
          sources.map((s) => ({
            source: s,
            sourceLocale: src,
            targetLocale: "_estimate_", // placeholder — replaced per target
            format,
            voice: userSettings.voice || "",
            glossary: userSettings.glossary,
          }))
        );
        // We can't pre-check cache for each target locale without a key per
        // target; instead just estimate the unfiltered work and call out
        // a cached count once we know per-locale below.
        void lookups;
        const est = (typeof provFn.estimate === "function")
          ? await provFn.estimate({ text: sources })
          : {
              inputTokens: Math.ceil(sources.reduce((a, s) => a + s.length, 0) / 4),
              estimatedOutputTokens: Math.ceil(sources.reduce((a, s) => a + s.length, 0) * 1.25 / 4),
              estimatedCostUsd: undefined,
            };
        return {
          sent: sources.length,
          inputTokens: est.inputTokens || 0,
          estimatedOutputTokens: est.estimatedOutputTokens || 0,
          estimatedCostUsd: est.estimatedCostUsd,
        };
      };

      const blocksFlat = bag.blocks.flatMap((b) => b.items);
      const [plainEst, htmlEst, blocksEst] = await Promise.all([
        estimateGroup(bag.plain, "plain"),
        estimateGroup(bag.html, "html"),
        estimateGroup(blocksFlat, "blocks"),
      ]);

      // Per-locale cache-hit subtraction. The provider call is per-locale, so
      // a string that's cached for `en` may still need translation for `fr`.
      // Also probes whether each target locale already has a draft entry so
      // the UI can warn about overwriting non-empty content.
      const perLocale = [];
      for (const target of targets) {
        let cachedItems = 0;
        let cachedChars = 0;
        const checkOne = async (items, format) => {
          if (items.length === 0) return;
          const sources = items.map((it) => it.text);
          const lookups = await cache.getMany(
            sources.map((s) => ({
              source: s,
              sourceLocale: src,
              targetLocale: target,
              format,
              voice: userSettings.voice || "",
              glossary: userSettings.glossary,
            }))
          );
          for (let i = 0; i < lookups.length; i++) {
            if (lookups[i].hit) {
              cachedItems += 1;
              cachedChars += sources[i].length;
            }
          }
        };
        await checkOne(bag.plain, "plain");
        await checkOne(bag.html, "html");
        await checkOne(blocksFlat, "blocks");
        let exists = false;
        try {
          const existing = await strapi.documents(uid).findOne({
            documentId,
            locale: target,
            status: "draft",
          });
          exists = !!existing;
        } catch {
          exists = false;
        }
        perLocale.push({
          locale: target,
          cachedItems,
          cachedChars,
          exists,
        });
      }

      const totalInputTokens =
        (plainEst.inputTokens + htmlEst.inputTokens + blocksEst.inputTokens) *
        targets.length;
      const totalOutputTokens =
        (plainEst.estimatedOutputTokens + htmlEst.estimatedOutputTokens + blocksEst.estimatedOutputTokens) *
        targets.length;
      const perLocaleCost =
        (plainEst.estimatedCostUsd || 0) +
        (htmlEst.estimatedCostUsd || 0) +
        (blocksEst.estimatedCostUsd || 0);
      const totalCost = perLocaleCost ? perLocaleCost * targets.length : undefined;

      // Summarise components / dynamic-zones that were walked so the picker
      // can show editors "12 text fields · 3 rich-text · 1 dynamic zone (Hero,
      // Gallery)" before they click translate.
      const componentsSeen = new Set();
      const collectComponents = (attrList, value, depth = 0) => {
        if (depth > 6) return;
        for (const attr of attrList) {
          const v = value ? value[attr.name] : undefined;
          if (v == null) continue;
          if (attr.type === "component" && attr.component) {
            componentsSeen.add(attr.component);
            try {
              const inner = fieldsService.describe(attr.component).attributes;
              const arr = attr.repeatable && Array.isArray(v) ? v : [v];
              for (const item of arr) {
                if (item) collectComponents(inner, item, depth + 1);
              }
            } catch {
              // ignore — unknown component
            }
          } else if (attr.type === "dynamiczone" && Array.isArray(v)) {
            for (const item of v) {
              if (item && item.__component) {
                componentsSeen.add(item.__component);
                try {
                  const inner = fieldsService.describe(item.__component).attributes;
                  collectComponents(inner, item, depth + 1);
                } catch {
                  // ignore — unknown component
                }
              }
            }
          }
        }
      };
      collectComponents(ctDescriptor.attributes, source);

      return {
        inputTokens: totalInputTokens,
        estimatedOutputTokens: totalOutputTokens,
        estimatedCostUsd: totalCost,
        targets: targets.length,
        groups: {
          plain: { items: bag.plain.length },
          html: { items: bag.html.length },
          blocks: { items: blocksFlat.length },
        },
        components: [...componentsSeen],
        perLocale,
      };
    },
  };
};
