// Preview-before-save flow.
//
// translateDocumentPreview() runs the same walker + provider calls as
// translateDocument() but stops short of the final upsert. The proposed
// payload + a structural diff vs. the current target-locale entry are
// stashed in strapi.store under a 1h TTL key. The frontend renders the
// diff and lets the editor accept or discard.
//
// Accept applies the proposed payload via the existing translate service's
// internal upsert path. Discard just deletes the cached preview.

import crypto from "node:crypto";

const STORE_KEY = { type: "plugin", name: "translate", key: "previews" };
const TTL_MS = 60 * 60 * 1000; // 1 hour

// Strapi-managed keys that exist on the populated source entry but never on
// the proposed payload. Including them in the diff floods the UI with noise
// like `id: 42 → undefined` or `locale: "en" → undefined` — none of which
// represents a translation decision the editor needs to review.
const SYSTEM_KEYS = new Set([
  "id",
  "documentId",
  "locale",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "createdBy",
  "updatedBy",
  "localizations",
]);

/**
 * Recursive diff: returns an array of { path, before, after } for every
 * leaf that differs. Arrays are diffed by index; objects by key union.
 * Whitespace-only differences are still reported (it's a translation —
 * leading/trailing whitespace can be meaningful).
 *
 * System keys (id, locale, timestamps, …) are skipped at every depth so
 * component/dynamic-zone children don't drag their own ids into the diff.
 */
const diff = (before, after, pathPrefix = []) => {
  const out = [];
  const walk = (a, b, path) => {
    if (a === b) return;
    if (typeof a !== typeof b || a === null || b === null) {
      out.push({ path: path.join("."), before: a, after: b });
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) walk(a[i], b[i], path.concat(i));
      return;
    }
    if (typeof a === "object" && typeof b === "object") {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        if (SYSTEM_KEYS.has(k)) continue;
        walk(a[k], b[k], path.concat(k));
      }
      return;
    }
    // Primitive scalar mismatch
    out.push({ path: path.join("."), before: a, after: b });
  };
  walk(before, after, pathPrefix);
  return out;
};

const newId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `prev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

// Numeric-aware descending path sort. Excluded paths are reverted one by
// one; when reverting removes an array element (splice), later indices
// shift — processing deepest/highest indices first keeps the remaining
// paths valid.
const comparePathsDesc = (a, b) => {
  const sa = a.split(".");
  const sb = b.split(".");
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    if (sa[i] === sb[i]) continue;
    const na = /^\d+$/.test(sa[i]) ? Number(sa[i]) : null;
    const nb = /^\d+$/.test(sb[i]) ? Number(sb[i]) : null;
    if (na !== null && nb !== null) return nb - na;
    return sb[i] < sa[i] ? -1 : 1;
  }
  return sb.length - sa.length;
};

/**
 * Revert a set of diff paths on the proposed payload so those fields keep
 * whatever the target locale currently holds. Mutates `proposed` in place
 * (callers pass a clone).
 *
 * - before defined   -> write the current value back over the translation
 * - before undefined -> the field doesn't exist in the target today; drop it
 *   from the payload (splicing array elements so no `null` holes remain)
 */
const revertExcludedPaths = (proposed, diffRows, excludedPaths) => {
  const byPath = new Map(diffRows.map((d) => [d.path, d]));
  const paths = excludedPaths
    .filter((p) => byPath.has(p))
    .sort(comparePathsDesc);
  for (const path of paths) {
    const segments = path.split(".");
    let parent = proposed;
    for (let i = 0; i < segments.length - 1 && parent != null; i++) {
      parent = parent[segments[i]];
    }
    if (parent == null || typeof parent !== "object") continue;
    const leaf = segments[segments.length - 1];
    const before = byPath.get(path).before;
    if (before === undefined) {
      if (Array.isArray(parent) && /^\d+$/.test(leaf)) {
        parent.splice(Number(leaf), 1);
      } else {
        delete parent[leaf];
      }
    } else {
      parent[leaf] = before;
    }
  }
};

export default ({ strapi }) => {
  const store = () => strapi.store(STORE_KEY);

  const readAll = async () => {
    const data = await store().get();
    if (data && typeof data === "object") return data;
    return {};
  };

  const writeAll = async (data) => {
    await store().set({ value: data });
  };

  const cleanupExpired = (data) => {
    const now = Date.now();
    let changed = false;
    for (const id of Object.keys(data)) {
      if (now - (data[id].createdAt || 0) > TTL_MS) {
        delete data[id];
        changed = true;
      }
    }
    return changed;
  };

  return {
    diff,

    /**
     * Generate a preview. Calls the translate service to do all the work
     * up to (but not including) the upsert, captures the proposed payload,
     * computes the diff vs. the current target locale, and stashes both.
     */
    async create({ uid, documentId, sourceLocale, targetLocale, actingUserId, signal, onProgress }) {
      const translate = strapi.plugin("translate").service("translate");
      // Run a special "dry" translateDocument that returns the proposed
      // payload + warnings without committing.
      const result = await translate.translateDocumentDry({
        uid,
        documentId,
        sourceLocale,
        targetLocale,
        actingUserId,
        signal,
        onProgress,
      });

      const existing = await strapi.documents(uid).findOne({
        documentId,
        locale: targetLocale,
        status: "draft",
      });
      const d = diff(existing || {}, result.proposed || {});

      const id = newId();
      const data = await readAll();
      cleanupExpired(data);
      data[id] = {
        id,
        uid,
        documentId,
        sourceLocale,
        targetLocale,
        actingUserId: actingUserId || null,
        proposed: result.proposed,
        translatedPaths: result.translatedPaths || [],
        warnings: result.warnings || [],
        diff: d,
        createdAt: Date.now(),
      };
      await writeAll(data);
      return { previewId: id, diff: d, warnings: result.warnings || [], proposed: result.proposed };
    },

    async get(id) {
      const data = await readAll();
      cleanupExpired(data);
      const row = data[id];
      if (!row) return null;
      return row;
    },

    /**
     * Apply a preview. Calls the translate service's upsert helper with
     * the previously-computed payload, then removes the preview.
     *
     * `excludedPaths` (diff paths the editor deselected in the UI) are
     * reverted to the target locale's current value before committing, so
     * those fields keep their existing translation. Only paths present in
     * the stored diff are honoured.
     */
    async accept(id, { excludedPaths } = {}) {
      const data = await readAll();
      cleanupExpired(data);
      const row = data[id];
      if (!row) return { ok: false, reason: "not-found" };

      const excluded = Array.isArray(excludedPaths)
        ? excludedPaths.filter((p) => typeof p === "string" && p.length > 0)
        : [];
      // Clone before mutating: if the commit throws, the stored row must
      // keep the untouched payload so a retry with a different selection
      // starts from the original translation.
      let proposed = row.proposed;
      let translatedPaths =
        Array.isArray(row.translatedPaths) && row.translatedPaths.length > 0
          ? row.translatedPaths
          : undefined;
      if (excluded.length > 0) {
        proposed = JSON.parse(JSON.stringify(row.proposed || {}));
        revertExcludedPaths(proposed, row.diff || [], excluded);
        const excludedSet = new Set(excluded);
        if (translatedPaths) {
          translatedPaths = translatedPaths.filter((p) => !excludedSet.has(p));
        }
      }

      const translate = strapi.plugin("translate").service("translate");
      const repairWarnings = [];
      const entry = await translate.commitPreview(
        {
          uid: row.uid,
          documentId: row.documentId,
          targetLocale: row.targetLocale,
          proposed,
          actingUserId: row.actingUserId,
          // Previews stored before translatedPaths existed have no list —
          // pass undefined so the repair loop falls back to its permissive
          // "any non-empty string" matching instead of repairing nothing.
          translatedPaths,
        },
        {
          onRepair: (repairs) => {
            for (const r of repairs) {
              repairWarnings.push({
                kind: "validation-repair",
                path: r.path,
                message: r.message,
                before: r.before,
                after: r.after,
              });
            }
          },
        }
      );
      delete data[id];
      await writeAll(data);
      return { ok: true, entry, warnings: [...(row.warnings || []), ...repairWarnings] };
    },

    async discard(id) {
      const data = await readAll();
      cleanupExpired(data);
      if (!data[id]) return { ok: false, reason: "not-found" };
      delete data[id];
      await writeAll(data);
      return { ok: true };
    },
  };
};

export { diff };
