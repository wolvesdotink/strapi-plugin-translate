"use strict";

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

const crypto = require("node:crypto");

const STORE_KEY = { type: "plugin", name: "translate", key: "previews" };
const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Recursive diff: returns an array of { path, before, after } for every
 * leaf that differs. Arrays are diffed by index; objects by key union.
 * Whitespace-only differences are still reported (it's a translation —
 * leading/trailing whitespace can be meaningful).
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
      for (const k of keys) walk(a[k], b[k], path.concat(k));
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

module.exports = ({ strapi }) => {
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
     */
    async accept(id) {
      const data = await readAll();
      cleanupExpired(data);
      const row = data[id];
      if (!row) return { ok: false, reason: "not-found" };
      const translate = strapi.plugin("translate").service("translate");
      const entry = await translate.commitPreview({
        uid: row.uid,
        documentId: row.documentId,
        targetLocale: row.targetLocale,
        proposed: row.proposed,
        actingUserId: row.actingUserId,
      });
      delete data[id];
      await writeAll(data);
      return { ok: true, entry, warnings: row.warnings };
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

module.exports.diff = diff;
