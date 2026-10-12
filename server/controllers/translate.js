import { fingerprint } from "../services/content-tree";

// HTTP-facing controller for the translate plugin. Mounted under /translate/...
// All routes are admin-scoped (require an authenticated admin user).
//
// Translation runs as an async job. A single job can target one or many
// locales — they are processed sequentially so we don't multiply provider
// load by the number of locales (each locale already runs 10 chunks in
// parallel internally).
//
//   POST /translate/document         -> 202 { jobId }   (starts work in background)
//   GET  /translate/jobs/:id         -> snapshot { state, progress, targets, ... }
//   POST /translate/jobs/:id/cancel  -> 200 { ok: true } | 409 | 404

const READ_ACTION = "plugin::content-manager.explorer.read";
const UPDATE_ACTION = "plugin::content-manager.explorer.update";

const isScoped = id => typeof id === "string" && id.startsWith("change_");
const fail = (ctx, err) => {
  ctx.status = err.status || 500;
  ctx.body = { error: { name: "TranslationError", message: err.message, details: err.details || {} } };
};

const permissionField = (strapi, uid, path) => {
  const parts = [];
  let model = uid;
  for (const segment of path) {
    if (typeof segment === "number") continue;
    parts.push(segment);
    const attr = strapi.getModel(model)?.attributes?.[segment];
    // Strapi grants dynamic-zone permissions for the container, rather than
    // each concrete component type's leaves. Components use nested fields.
    if (attr?.type === "dynamiczone") break;
    if (attr?.type === "component") model = attr.component;
  }
  return parts.join(".");
};

const authorizeChanges = (strapi, ctx) => async prepared => {
  const checker = strapi.plugin("content-manager").service("permission-checker").create({ userAbility: ctx.state.userAbility, model: prepared.uid });
  if (checker.cannot.read(prepared.source) || (prepared.target ? checker.cannot.update(prepared.target) : checker.cannot.create())) {
    throw Object.assign(new Error("Missing permission for this document or language."), { status: 403 });
  }
  for (const op of prepared.ops) {
    const field = permissionField(strapi, prepared.uid, op.path);
    if (checker.cannot.read(prepared.source, field) || (prepared.target ? checker.cannot.update(prepared.target, field) : checker.cannot.create(null, field))) {
      throw Object.assign(new Error(`Missing permission for field ${field}.`), { status: 403 });
    }
  }
  if (prepared.proposed) {
    const sanitized = prepared.target ? await checker.sanitizeUpdateInput(prepared.target)(prepared.proposed) : await checker.sanitizeCreateInput(prepared.proposed);
    if (fingerprint(sanitized) !== fingerprint(prepared.proposed)) throw Object.assign(new Error("The selected module contains fields you cannot update."), { status: 403 });
  }
  const relations = Object.values(prepared.current.fields).filter(f => f.type === "relation" && (prepared.initialTranslation || prepared.ops.some(op => op.moduleKey === f.moduleKey)));
  for (const ref of relations) {
    if (!strapi.getModel(ref.target)?.pluginOptions?.i18n?.localized) continue;
    const relatedChecker = strapi.plugin("content-manager").service("permission-checker").create({ userAbility: ctx.state.userAbility, model: ref.target });
    for (const documentId of Array.isArray(ref.value) ? ref.value : ref.value ? [ref.value] : []) {
      for (const locale of [prepared.sourceLocale, prepared.targetLocale]) {
        const entry = await strapi.documents(ref.target).findOne({ documentId, locale, status: "draft" });
        if (entry && (relatedChecker.cannot.read(entry) || (entry.title && relatedChecker.cannot.read(entry, "title")))) throw Object.assign(new Error("Missing read permission for a linked item."), { status: 403 });
      }
    }
  }
};

const emptyFormatProgress = () => ({
  plain: { done: 0, total: 0 },
  html: { done: 0, total: 0 },
  blocks: { done: 0, total: 0 },
});

// Check `actions` against the caller's admin ability for `uid`. Returns
// true only if every action is granted. Used by the preview-by-id routes,
// where the uid lives in the stored preview row rather than the request
// body, so the route-level hasContentPermissions policy can't reach it.
const userCanOnUid = (ctx, uid, actions) => {
  const ability = ctx.state?.userAbility;
  if (!ability || !uid) return false;
  return actions.every((action) => ability.can(action, uid));
};

// Fail-closed RBAC check for in-controller filtering. Returns true if the
// caller can perform `action` on `uid`. If userAbility isn't attached, this
// returns false — listJobs/contentTypes use this so a missing ability does
// NOT leak the full job/CT registry.
const userCanOrDeny = (ctx, uid, action) => {
  const ability = ctx.state?.userAbility;
  if (!ability) return false;
  if (!uid) return true;
  try {
    return !!ability.can(action, uid);
  } catch {
    return false;
  }
};

// Derive the overall job state from per-target states once the loop ends.
// - all done                                  -> "done"
// - mix of done + failed                      -> "partial"
// - all failed                                -> "failed"
// - any cancelled and at least one not done   -> "cancelled"
const deriveOverallState = (targets) => {
  const counts = { done: 0, failed: 0, cancelled: 0, pending: 0, running: 0 };
  for (const t of targets) counts[t.state] = (counts[t.state] || 0) + 1;
  if (counts.cancelled > 0 && counts.done < targets.length) return "cancelled";
  if (counts.failed > 0 && counts.done > 0) return "partial";
  if (counts.failed === targets.length) return "failed";
  return "done";
};

export default ({ strapi }) => {
  const jobs = () => strapi.plugin("translate").service("jobs");
  const translate = () => strapi.plugin("translate").service("translate");
  const settings = () => strapi.plugin("translate").service("settings");
  const localesSvc = () => strapi.plugin("translate").service("locales");
  const cache = () => strapi.plugin("translate").service("cache");
  const preview = () => strapi.plugin("translate").service("preview");

  return {
    /**
     * POST /translate/document
     * body: { uid, documentId, sourceLocale, targetLocale | targetLocales }
     * Starts a translation job that fans out across targetLocales sequentially.
     * Returns the jobId immediately.
     */
    async translateDocument(ctx) {
      const body = ctx.request.body || {};
      const { uid, documentId, sourceLocale } = body;

      // Normalise to an array. Accept either shape so old callers keep working.
      const rawTargets = Array.isArray(body.targetLocales)
        ? body.targetLocales
        : body.targetLocale
        ? [body.targetLocale]
        : [];

      if (!uid || !documentId) {
        return ctx.badRequest("uid and documentId are required");
      }
      if (rawTargets.length === 0) {
        return ctx.badRequest(
          "targetLocale or targetLocales is required"
        );
      }
      // Live locale validation — pull from i18n at request time so a newly-
      // enabled locale doesn't require a plugin code change.
      const supported = await localesSvc().codes();

      // Dedupe while preserving order.
      const seen = new Set();
      const targetLocales = [];
      for (const code of rawTargets) {
        if (typeof code !== "string" || !code) {
          return ctx.badRequest("targetLocales must be non-empty strings");
        }
        if (!supported.has(code)) {
          return ctx.badRequest(`unsupported targetLocale: ${code}`);
        }
        if (sourceLocale && code === sourceLocale) {
          return ctx.badRequest(
            `targetLocale ${code} matches sourceLocale; nothing to translate`
          );
        }
        if (!seen.has(code)) {
          seen.add(code);
          targetLocales.push(code);
        }
      }
      if (sourceLocale && !supported.has(sourceLocale)) {
        return ctx.badRequest(`unsupported sourceLocale: ${sourceLocale}`);
      }

      const actingUserId = ctx.state?.user?.id || null;

      const job = jobs().create({
        uid,
        documentId,
        sourceLocale,
        targetLocales,
        userId: actingUserId,
      });
      job.state = "running";

      // Fire-and-forget: the request returns immediately; the loop below
      // mutates the live job record. The admin UI polls GET /translate/jobs/:id
      // to follow progress.
      (async () => {
        for (let i = 0; i < job.targets.length; i++) {
          if (job.signal.aborted) break;

          const target = job.targets[i];
          job.activeTargetIndex = i;
          // Mirror the active target's locale + reset legacy top-level progress
          // so any older snapshot consumer sees the right "currently translating".
          job.targetLocale = target.locale;
          job.progress = emptyFormatProgress();
          target.state = "running";

          try {
            const { entry, warnings } = await translate().translateDocument({
              uid,
              documentId,
              sourceLocale,
              targetLocale: target.locale,
              actingUserId,
              signal: job.signal,
              onProgress: ({ format, done, total }) => {
                if (target.progress[format]) {
                  target.progress[format] = { done, total };
                }
                if (job.progress[format]) {
                  job.progress[format] = { done, total };
                }
              },
            });
            target.state = "done";
            target.result = {
              documentId: entry.documentId,
              locale: entry.locale,
              warnings: warnings || [],
            };
            // Keep legacy top-level result pointed at the most-recent success.
            job.result = target.result;
          } catch (err) {
            if (err?.name === "AbortError" || job.signal.aborted) {
              target.state = "cancelled";
              // Anything still pending after this is also cancelled.
              for (let j = i + 1; j < job.targets.length; j++) {
                job.targets[j].state = "cancelled";
              }
              strapi.log.info(
                `[translate] job ${job.id} cancelled at ${target.locale}`
              );
              break;
            }
            target.state = "failed";
            target.error = err?.message || String(err);
            strapi.log.error(
              `[translate] job ${job.id} target ${target.locale} failed: ${err?.message || err}`
            );
            if (err?.stack) strapi.log.error(err.stack);
            // Per-locale failure does not abort the batch — continue with the
            // remaining targets so a transient blip on one locale doesn't doom
            // the whole batch.
          }
        }

        job.activeTargetIndex = -1;
        job.state = deriveOverallState(job.targets);
        if (job.state === "failed") {
          // Surface a representative error on the legacy top-level field.
          const firstFail = job.targets.find((t) => t.error);
          job.error = firstFail?.error || "Translation failed";
        }
        job.finishedAt = Date.now();
      })().catch((err) => {
        // Belt-and-braces: the loop above already catches per-target errors,
        // but if something escapes (e.g. programmer error in the loop itself)
        // we still want the job to terminate cleanly so the UI's poll exits.
        job.state = "failed";
        job.error = err?.message || String(err);
        job.finishedAt = Date.now();
        strapi.log.error(
          `[translate] job ${job.id} crashed: ${err?.message || err}`
        );
        if (err?.stack) strapi.log.error(err.stack);
      });

      ctx.status = 202;
      ctx.body = { jobId: job.id };
    },

    /**
     * POST /translate/bulk
     * body: { uid, documentIds: string[], sourceLocale?, targetLocales }
     * Translates many documents of one CT into one or more target locales.
     * Returns the jobId immediately; progress is exposed through the same
     * /translate/jobs/:id endpoint.
     */
    async bulkTranslate(ctx) {
      const body = ctx.request.body || {};
      const { uid, sourceLocale } = body;
      const documentIds = Array.isArray(body.documentIds) ? body.documentIds : [];
      const rawTargets = Array.isArray(body.targetLocales)
        ? body.targetLocales
        : body.targetLocale
        ? [body.targetLocale]
        : [];

      if (!uid) return ctx.badRequest("uid is required");
      if (documentIds.length === 0) {
        return ctx.badRequest("documentIds must be a non-empty array");
      }
      if (rawTargets.length === 0) {
        return ctx.badRequest("targetLocales is required");
      }
      const supported = await localesSvc().codes();
      const seen = new Set();
      const targetLocales = [];
      for (const code of rawTargets) {
        if (typeof code !== "string" || !code) {
          return ctx.badRequest("targetLocales must be non-empty strings");
        }
        if (!supported.has(code)) {
          return ctx.badRequest(`unsupported targetLocale: ${code}`);
        }
        if (sourceLocale && code === sourceLocale) {
          return ctx.badRequest(
            `targetLocale ${code} matches sourceLocale; nothing to translate`
          );
        }
        if (!seen.has(code)) {
          seen.add(code);
          targetLocales.push(code);
        }
      }
      if (sourceLocale && !supported.has(sourceLocale)) {
        return ctx.badRequest(`unsupported sourceLocale: ${sourceLocale}`);
      }

      const actingUserId = ctx.state?.user?.id || null;
      const job = jobs().create({
        uid,
        documentId: null,
        sourceLocale,
        targetLocales,
        userId: actingUserId,
        documents: documentIds.map((id) => ({ documentId: id })),
      });
      job.state = "running";

      // Derive a per-locale aggregate state from every doc's same-locale
      // target. Surfaced on the legacy top-level job.targets[] so JobHistory
      // (and any other snapshot consumer) sees real progress instead of
      // permanently-pending badges.
      const aggregateTopLevelTargets = () => {
        for (let li = 0; li < job.targets.length; li++) {
          const locale = job.targets[li].locale;
          let done = 0;
          let failed = 0;
          let cancelled = 0;
          let pending = 0;
          let running = 0;
          for (const d of job.documents) {
            const t = d.targets[li];
            if (!t) continue;
            if (t.state === "done") done += 1;
            else if (t.state === "failed") failed += 1;
            else if (t.state === "cancelled") cancelled += 1;
            else if (t.state === "running") running += 1;
            else pending += 1;
          }
          let agg;
          if (running > 0) agg = "running";
          else if (pending > 0 && done + failed + cancelled === 0) agg = "pending";
          else if (cancelled > 0 && done < job.documents.length) agg = "cancelled";
          else if (failed > 0 && done === 0) agg = "failed";
          else if (failed > 0 || cancelled > 0 || pending > 0) agg = "partial";
          else agg = "done";
          job.targets[li].state = agg;
        }
      };

      (async () => {
        const docs = job.documents;
        for (let di = 0; di < docs.length; di++) {
          if (job.signal.aborted) break;
          const doc = docs[di];
          doc.state = "running";
          let anyFailed = false;
          let anyTargetRan = false;
          for (let ti = 0; ti < doc.targets.length; ti++) {
            if (job.signal.aborted) {
              // Mark untouched targets cancelled so the snapshot reflects
              // reality instead of leaving them pending forever.
              for (let tj = ti; tj < doc.targets.length; tj++) {
                if (doc.targets[tj].state === "pending") {
                  doc.targets[tj].state = "cancelled";
                }
              }
              break;
            }
            anyTargetRan = true;
            const target = doc.targets[ti];
            target.state = "running";
            try {
              const { entry, warnings } = await translate().translateDocument({
                uid,
                documentId: doc.documentId,
                sourceLocale,
                targetLocale: target.locale,
                actingUserId,
                signal: job.signal,
                onProgress: ({ format, done, total }) => {
                  if (target.progress[format]) {
                    target.progress[format] = { done, total };
                  }
                },
              });
              target.state = "done";
              target.result = {
                documentId: entry.documentId,
                locale: entry.locale,
                warnings: warnings || [],
              };
            } catch (err) {
              if (err?.name === "AbortError" || job.signal.aborted) {
                target.state = "cancelled";
                anyFailed = true;
                // Mark the remaining untouched targets cancelled too.
                for (let tj = ti + 1; tj < doc.targets.length; tj++) {
                  if (doc.targets[tj].state === "pending") {
                    doc.targets[tj].state = "cancelled";
                  }
                }
                break;
              }
              target.state = "failed";
              target.error = err?.message || String(err);
              anyFailed = true;
            }
          }
          const allDone = doc.targets.every((t) => t.state === "done");
          const anyDone = doc.targets.some((t) => t.state === "done");
          const anyCancelled = doc.targets.some((t) => t.state === "cancelled");
          if (allDone) {
            doc.state = "done";
          } else if (anyDone) {
            doc.state = "partial";
          } else if (!anyTargetRan && anyCancelled) {
            doc.state = "cancelled";
          } else if (anyFailed && anyCancelled) {
            doc.state = "cancelled";
          } else if (anyFailed) {
            doc.state = "failed";
          } else {
            // No targets ran AND none are cancelled means the outer abort
            // fired before this doc even started — treat as cancelled.
            doc.state = "cancelled";
          }
          aggregateTopLevelTargets();
        }
        aggregateTopLevelTargets();
        // Overall state derivation.
        const counts = { done: 0, failed: 0, cancelled: 0, partial: 0 };
        for (const d of docs) counts[d.state] = (counts[d.state] || 0) + 1;
        if (counts.cancelled > 0 && counts.done < docs.length) {
          job.state = "cancelled";
        } else if (counts.done === docs.length) {
          job.state = "done";
        } else if (counts.done > 0 || counts.partial > 0) {
          job.state = "partial";
        } else {
          job.state = "failed";
        }
        job.finishedAt = Date.now();
      })().catch((err) => {
        job.state = "failed";
        job.error = err?.message || String(err);
        job.finishedAt = Date.now();
        strapi.log.error(
          `[translate] bulk job ${job.id} crashed: ${err?.message || err}`
        );
      });

      ctx.status = 202;
      ctx.body = { jobId: job.id };
    },

    /**
     * GET /translate/jobs/:id
     */
    async getJob(ctx) {
      const { id } = ctx.params;
      const snapshot = jobs().get(id);
      if (!snapshot) return ctx.notFound("job not found");
      if (snapshot.source === "preview" && snapshot.userId !== ctx.state?.user?.id) return ctx.notFound("job not found");
      if (snapshot.uid && !userCanOrDeny(ctx, snapshot.uid, READ_ACTION)) {
        return ctx.notFound("job not found");
      }
      if (snapshot.source === "preview") {
        try {
          const selective = strapi.plugin("translate").service("selective-preview");
          for (const target of snapshot.targets) {
            if (!target.result?.previewId) continue;
            const row = await selective.get(target.result.previewId, ctx.state.user.id);
            if (!row) continue;
            await authorizeChanges(strapi, ctx)(row.prepared);
            for (const child of row.children) await authorizeChanges(strapi, ctx)(child.prepared);
          }
        } catch { return ctx.notFound("job not found"); }
      }
      ctx.body = snapshot;
    },

    /**
     * GET /translate/jobs
     * Query: limit (default 50, max 200)
     * Returns the most recent jobs first. Used by the job history page.
     */
    async listJobs(ctx) {
      const limit = Math.max(
        1,
        Math.min(200, parseInt(ctx.query?.limit, 10) || 50)
      );
      const all = jobs().list();
      // Sort newest-first by startedAt, fall back to finishedAt
      all.sort((a, b) => {
        const ta = a.startedAt || 0;
        const tb = b.startedAt || 0;
        return tb - ta;
      });
      // Fail closed: when userAbility is missing, return no jobs rather than
      // leaking the registry.
      const filtered = all.filter((j) => userCanOrDeny(ctx, j.uid, READ_ACTION) && (j.source !== "preview" || j.userId === ctx.state?.user?.id))
        .map(j => j.source === "preview" ? { ...j, targets: j.targets.map(target => ({ ...target, result: target.result ? { previewId: target.result.previewId, warnings: target.result.warnings || [] } : null })) } : j);
      ctx.body = {
        jobs: filtered.slice(0, limit),
        total: filtered.length,
      };
    },

    /**
     * POST /translate/jobs/:id/cancel
     */
    async cancelJob(ctx) {
      const { id } = ctx.params;
      const snapshot = jobs().get(id);
      if (!snapshot) return ctx.notFound("job not found");
      if (snapshot.source === "preview" && snapshot.userId !== ctx.state?.user?.id) return ctx.notFound("job not found");
      if (snapshot.uid && !userCanOrDeny(ctx, snapshot.uid, UPDATE_ACTION)) {
        return ctx.notFound("job not found");
      }
      const res = jobs().cancel(id);
      if (!res.ok && res.reason === "not-found") {
        return ctx.notFound("job not found");
      }
      if (!res.ok && res.reason === "already-terminal") {
        ctx.status = 409;
        ctx.body = { ok: false, reason: res.reason, state: res.state };
        return;
      }
      ctx.body = { ok: true };
    },

    /**
     * GET /translate/usage
     * Returns { count, limit } from the provider.
     */
    async usage(ctx) {
      try {
        const u = await translate().usage();
        ctx.body = u;
      } catch (err) {
        ctx.throw(500, err.message);
      }
    },

    /**
     * POST /translate/estimate
     * body: { uid, documentId, sourceLocale?, targetLocales }
     * Returns token + cost estimate without burning provider calls.
     */
    async estimate(ctx) {
      const body = ctx.request.body || {};
      const { uid, documentId, sourceLocale } = body;
      const rawTargets = Array.isArray(body.targetLocales)
        ? body.targetLocales
        : body.targetLocale
        ? [body.targetLocale]
        : [];
      if (!uid || !documentId) {
        return ctx.badRequest("uid and documentId are required");
      }
      if (rawTargets.length === 0) {
        return ctx.badRequest("targetLocales is required");
      }
      const supported = await localesSvc().codes();
      if (sourceLocale && !supported.has(sourceLocale)) {
        return ctx.badRequest(`unsupported sourceLocale: ${sourceLocale}`);
      }
      for (const code of rawTargets) {
        if (typeof code !== "string" || !code) {
          return ctx.badRequest("targetLocales must be non-empty strings");
        }
        if (!supported.has(code)) {
          return ctx.badRequest(`unsupported targetLocale: ${code}`);
        }
        if (sourceLocale && code === sourceLocale) {
          return ctx.badRequest(
            `targetLocale ${code} matches sourceLocale; nothing to translate`
          );
        }
      }
      try {
        if (body.mode === "changes") {
          ctx.body = await strapi.plugin("translate").service("selective-preview").estimate({ ...body, sourceLocale: sourceLocale || strapi.plugin("translate").config.sourceLocale }, authorizeChanges(strapi, ctx));
          return;
        }
        const est = await translate().estimate({
          uid,
          documentId,
          sourceLocale,
          targetLocales: rawTargets,
        });
        ctx.body = est;
      } catch (err) {
        ctx.throw(500, err.message);
      }
    },

    /**
     * GET /translate/locales
     * Returns the list of locales the project has configured (read from the
     * i18n plugin) so the admin UI can render a target-locale dropdown without
     * hardcoding.
     */
    async locales(ctx) {
      try {
        const list = await localesSvc().list();
        ctx.body = list;
      } catch (err) {
        ctx.throw(500, err.message);
      }
    },

    /**
     * GET /translate/settings
     * Returns the admin-editable voice + glossary settings.
     */
    async getSettings(ctx) {
      const svc = settings();
      const value = await svc.get();
      ctx.body = {
        ...value,
        supportedLocales: await svc.supportedLocales(),
      };
    },

    /**
     * PUT /translate/settings
     * body: { voice, glossary: { preserveExact, perLocale } }
     */
    async updateSettings(ctx) {
      const body = ctx.request.body || {};
      const value = await settings().set(body);
      ctx.body = value;
    },

    /**
     * POST /translate/settings/reset
     * Restores the defaults captured at register-time (config/plugins.js
     * voice + glossary.json).
     */
    async resetSettings(ctx) {
      const value = await settings().reset();
      ctx.body = value;
    },

    /** POST /translate/changes — persisted, permission-checked pending work. */
    async getChanges(ctx) {
      const body = ctx.request.body || {};
      const sourceLocale = body.sourceLocale || strapi.plugin("translate").config.sourceLocale;
      if (!body.uid || !body.documentId || !sourceLocale) return ctx.badRequest("uid, documentId and sourceLocale are required");
      try {
        const changes = strapi.plugin("translate").service("changes");
        const out = await changes.get({ ...body, sourceLocale, actingUserId: ctx.state.user.id });
        const source = await changes.load(body.uid, body.documentId, sourceLocale);
        if (source) {
          const prepared = { uid: body.uid, sourceLocale, targetLocale: sourceLocale, source, target: source, current: { fields: {} }, ops: out.modules.flatMap(m => m.fields.map(f => ({ path: f.path }))) };
          await authorizeChanges(strapi, ctx)(prepared);
        }
        const checker = strapi.plugin("content-manager").service("permission-checker").create({ userAbility: ctx.state.userAbility, model: body.uid });
        const targetLocales = [];
        for (const locale of await localesSvc().codes()) {
          if (locale === sourceLocale) continue;
          const target = await changes.load(body.uid, body.documentId, locale);
          if (target ? checker.can.update(target) : checker.can.create({ locale })) targetLocales.push(locale);
        }
        ctx.body = { ...out, targetLocales };
      } catch (err) { fail(ctx, err); }
    },

    async createPreview(ctx) {
      if (ctx.request.body?.mode === "changes") return strapi.plugin("translate").controller("translate").createSelectivePreview(ctx);
      const body = ctx.request.body || {};
      const { uid, documentId, sourceLocale, targetLocale } = body;
      if (!uid || !documentId || !targetLocale) {
        return ctx.badRequest("uid, documentId, and targetLocale are required");
      }
      const supported = await localesSvc().codes();
      if (!supported.has(targetLocale)) {
        return ctx.badRequest(`unsupported targetLocale: ${targetLocale}`);
      }
      const actingUserId = ctx.state?.user?.id || null;
      try {
        const out = await preview().create({
          uid,
          documentId,
          sourceLocale,
          targetLocale,
          actingUserId,
        });
        ctx.body = out;
      } catch (err) {
        ctx.throw(500, err.message);
      }
    },

    /** POST /translate/preview with mode:"changes" — asynchronous locale previews. */
    async createSelectivePreview(ctx) {
      const body = ctx.request.body || {};
      const { uid, documentId } = body;
      const sourceLocale = body.sourceLocale || strapi.plugin("translate").config.sourceLocale;
      const supported = await localesSvc().codes();
      const targets = Array.isArray(body.targetLocales) ? [...new Set(body.targetLocales)] : [];
      if (!uid || !documentId || !supported.has(sourceLocale) || !targets.length || targets.some(l => !supported.has(l) || l === sourceLocale)) return ctx.badRequest("Choose supported target languages different from the source.");
      if (body.moduleKeys && (!Array.isArray(body.moduleKeys) || body.moduleKeys.some(k => typeof k !== "string"))) return ctx.badRequest("Invalid module selection");
      const selective = strapi.plugin("translate").service("selective-preview");
      const job = jobs().create({ uid, documentId, sourceLocale, targetLocales: targets, userId: ctx.state.user.id, source: "preview" });
      job.state = "running";
      const authorize = authorizeChanges(strapi, ctx);
      (async () => {
        for (let i = 0; i < job.targets.length; i++) {
          const target = job.targets[i];
          if (job.signal.aborted) { target.state = "cancelled"; continue; }
          target.state = "running"; job.activeTargetIndex = i;
          try {
            const result = await selective.create({ uid, documentId, sourceLocale, targetLocale: target.locale,
              revision: body.revision, moduleKeys: body.moduleKeys, alignments: body.alignments?.[target.locale] || {},
              initialTranslation: body.initialTranslation === true, translateLinkedItems: body.translateLinkedItems === true,
              actingUserId: ctx.state.user.id, signal: job.signal,
              onProgress: ({ format, done, total }) => { target.progress[format] = { done, total }; },
            }, authorize);
            target.state = "done"; target.result = result;
          } catch (err) {
            target.state = job.signal.aborted ? "cancelled" : "failed";
            target.error = err.message;
            target.result = { details: err.details || {}, status: err.status || 500 };
          }
        }
        job.activeTargetIndex = -1; job.state = deriveOverallState(job.targets); job.finishedAt = Date.now();
        await jobs().persistNow();
      })().catch(err => { job.state = "failed"; job.error = err.message; job.finishedAt = Date.now(); jobs().persistNow().catch(() => {}); });
      ctx.status = 202; ctx.body = { jobId: job.id };
    },

    async getPreview(ctx) {
      if (isScoped(ctx.params.id)) {
        const selective = strapi.plugin("translate").service("selective-preview");
        const row = await selective.get(ctx.params.id, ctx.state.user.id);
        if (!row) return ctx.notFound("preview not found");
        try {
          await authorizeChanges(strapi, ctx)(row.prepared);
          for (const child of row.children) await authorizeChanges(strapi, ctx)(child.prepared);
          ctx.body = selective.publicPreview(row);
        } catch (err) { fail(ctx, err); }
        return;
      }
      const row = await preview().get(ctx.params.id);
      if (!row) return ctx.notFound("preview not found");
      if (!userCanOnUid(ctx, row.uid, [READ_ACTION])) {
        return ctx.forbidden("missing permission for this content type");
      }
      ctx.body = row;
    },

    /**
     * POST /translate/preview/:id/accept
     * body: { excludedPaths?: string[] } — diff paths the editor deselected;
     * those fields keep the target locale's current value.
     * Commits the proposed payload.
     */
    async acceptPreview(ctx) {
      if (isScoped(ctx.params.id)) {
        try {
          ctx.body = await strapi.plugin("translate").service("selective-preview").accept(ctx.params.id, { ...ctx.request.body, actingUserId: ctx.state.user.id }, authorizeChanges(strapi, ctx));
        } catch (err) { fail(ctx, err); }
        return;
      }
      const row = await preview().get(ctx.params.id);
      if (!row) return ctx.notFound("preview not found");
      if (!userCanOnUid(ctx, row.uid, [READ_ACTION, UPDATE_ACTION])) {
        return ctx.forbidden("missing permission for this content type");
      }
      const body = ctx.request.body || {};
      const excludedPaths = Array.isArray(body.excludedPaths)
        ? body.excludedPaths.filter((p) => typeof p === "string")
        : [];
      const res = await preview().accept(ctx.params.id, { excludedPaths });
      if (!res.ok && res.reason === "not-found") return ctx.notFound("preview not found");
      ctx.body = res;
    },

    /**
     * POST /translate/preview/:id/discard
     */
    async discardPreview(ctx) {
      if (isScoped(ctx.params.id)) {
        try { ctx.body = await strapi.plugin("translate").service("selective-preview").discard(ctx.params.id, ctx.state.user.id); }
        catch (err) { fail(ctx, err); }
        return;
      }
      const row = await preview().get(ctx.params.id);
      if (!row) return ctx.notFound("preview not found");
      if (!userCanOnUid(ctx, row.uid, [READ_ACTION, UPDATE_ACTION])) {
        return ctx.forbidden("missing permission for this content type");
      }
      const res = await preview().discard(ctx.params.id);
      if (!res.ok && res.reason === "not-found") return ctx.notFound("preview not found");
      ctx.body = res;
    },

    /**
     * GET /translate/cache/stats
     * Returns cache size + age for the admin UI.
     */
    async cacheStats(ctx) {
      ctx.body = await cache().stats();
    },

    /**
     * POST /translate/content/locale-status
     * body: { uid, documentId }
     * Returns per-locale status for the document — which locales exist as
     * a draft. Used by the locale-status pills in the document action picker.
     */
    async localeStatus(ctx) {
      const body = ctx.request.body || {};
      const { uid, documentId } = body;
      if (!uid || !documentId) {
        return ctx.badRequest("uid and documentId are required");
      }
      const localesList = await localesSvc().list();
      const out = [];
      for (const l of localesList) {
        try {
          const entry = await strapi.documents(uid).findOne({
            documentId,
            locale: l.code,
            status: "draft",
          });
          out.push({
            locale: l.code,
            name: l.name,
            isDefault: !!l.isDefault,
            exists: !!entry,
            updatedAt: entry?.updatedAt || null,
            publishedAt: entry?.publishedAt || null,
          });
        } catch (err) {
          // The probe failed — we genuinely don't know whether this locale
          // has content. Surface `unknown` so the UI can hide the
          // 'safe to write' affordance instead of assuming exists:false.
          strapi.log?.warn?.(
            `[translate] localeStatus probe failed for ${uid} ${documentId} ${l.code}: ${err?.message || err}`
          );
          out.push({
            locale: l.code,
            name: l.name,
            isDefault: !!l.isDefault,
            exists: false,
            unknown: true,
            updatedAt: null,
            publishedAt: null,
          });
        }
      }
      ctx.body = { locales: out };
    },

    /**
     * GET /translate/content-types
     * Lists content types that participate in i18n and have at least one
     * translatable field. Used by the bulk translation page.
     */
    async contentTypes(ctx) {
      const fieldsService = strapi.plugin("translate").service("translatable-fields");
      const all = strapi.contentTypes || {};
      const out = [];
      for (const [uid, schema] of Object.entries(all)) {
        if (!schema || typeof schema !== "object") continue;
        if (!uid.startsWith("api::")) continue;
        const localized = !!schema.pluginOptions?.i18n?.localized;
        if (!localized) continue;
        let attrs;
        try {
          attrs = fieldsService.describe(uid).attributes;
        } catch {
          continue;
        }
        const translatable = attrs.filter(
          (a) =>
            a.directive === "translate" &&
            (a.type === "string" ||
              a.type === "text" ||
              a.type === "richtext" ||
              a.type === "blocks" ||
              a.type === "component" ||
              a.type === "dynamiczone")
        );
        if (translatable.length === 0) continue;
        // Fail closed: without userAbility we cannot prove the caller has
        // read permission, so omit the CT from the listing.
        if (!userCanOrDeny(ctx, uid, READ_ACTION)) continue;
        out.push({
          uid,
          kind: schema.kind,
          displayName:
            schema.info?.displayName || schema.info?.singularName || uid,
          translatableFieldCount: translatable.length,
        });
      }
      out.sort((a, b) => a.displayName.localeCompare(b.displayName));
      ctx.body = { contentTypes: out };
    },

    /**
     * POST /translate/content/list
     * body: { uid, sourceLocale, limit?, start? }
     * Returns documentIds + a best-effort label for the bulk picker.
     */
    async contentList(ctx) {
      const body = ctx.request.body || {};
      const { uid, sourceLocale } = body;
      if (!uid) return ctx.badRequest("uid is required");
      const supported = await localesSvc().codes();
      const src =
        sourceLocale && supported.has(sourceLocale) ? sourceLocale : null;

      const limit = Math.max(1, Math.min(500, parseInt(body.limit, 10) || 100));
      const start = Math.max(0, parseInt(body.start, 10) || 0);

      const schema = strapi.getModel(uid);
      // Strapi 5 stores the editor-chosen "display field" in content-manager
      // configuration. Fall back to a list of conventional name fields so the
      // picker still produces a readable label on schemas that haven't been
      // configured.
      const labelCandidates = [];
      const cmMainField = schema?.info?.displayField;
      if (cmMainField) labelCandidates.push(cmMainField);
      for (const name of ["title", "name", "label", "heading", "slug"]) {
        if (schema?.attributes?.[name] && !labelCandidates.includes(name)) {
          labelCandidates.push(name);
        }
      }

      const pickLabel = (d) => {
        for (const f of labelCandidates) {
          if (typeof d[f] === "string" && d[f]) return d[f];
        }
        return d.documentId;
      };

      try {
        const docs = await strapi.documents(uid).findMany({
          locale: src,
          status: "draft",
          start,
          limit,
        });
        const list = (docs || []).map((d) => ({
          documentId: d.documentId,
          label: pickLabel(d),
          updatedAt: d.updatedAt || null,
        }));
        ctx.body = { documents: list, start, limit, total: list.length };
      } catch (err) {
        ctx.throw(500, err.message);
      }
    },

    /**
     * DELETE /translate/cache
     * Clears the translation memory cache. Returns the number of entries removed.
     */
    async clearCache(ctx) {
      const count = await cache().clear();
      ctx.body = { ok: true, cleared: count };
    },
  };
};
