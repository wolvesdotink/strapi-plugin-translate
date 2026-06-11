// Auto-translate lifecycle hook.
//
// Subscribes to Strapi v5's document service middleware. On a configured
// rule match (uid + locale + action), enqueues a translation job into the
// target locales. Loop prevention: jobs created via this service set
// `source: "auto"` on the job record AND we maintain an in-flight set of
// (uid:documentId:locale) keys so the post-translate write doesn't trigger
// recursion through update().
//
// Config shape (in config/plugins.js):
//
//   autoTranslate: {
//     enabled: true,
//     rules: [
//       { uid: "api::page.page",
//         sourceLocale: "de",
//         targetLocales: ["en", "fr"],
//         on: "publish" },              // "publish" | "update"
//     ],
//   }
//
// Rules are matched by exact uid + (sourceLocale matches or is undefined)
// + the lifecycle event. Multiple rules per uid are allowed; all matching
// rules fire.

const inFlight = new Set();

const inFlightKey = (uid, documentId, locale) =>
  `${uid}:${documentId}:${locale || ""}`;

const ruleMatches = (rule, { uid, action, locale }) => {
  if (!rule || rule.uid !== uid) return false;
  if (rule.on && rule.on !== action) return false;
  if (rule.sourceLocale && locale && rule.sourceLocale !== locale) return false;
  return true;
};

export default ({ strapi }) => {
  let installed = false;
  return {
    /**
     * Install the document-service middleware. Idempotent — safe to call
     * twice. Returns the list of (uid, action) keys we registered.
     */
    install() {
      if (installed) return { installed: 0 };
      const cfg = strapi.plugin("translate")?.config || {};
      const autoCfg = cfg.autoTranslate || {};
      if (autoCfg.enabled === false) {
        return { installed: 0 };
      }
      const rules = Array.isArray(autoCfg.rules) ? autoCfg.rules : [];
      if (rules.length === 0) {
        return { installed: 0 };
      }
      // The documents service exposes `use(middleware)` which is called with
      // ctx = { uid, action, params } and a `next` function. We only act on
      // post-write actions (`publish`, `update`).
      // Older codepaths used db.lifecycles.subscribe — we prefer document
      // middleware because it carries documentId.
      if (typeof strapi.documents?.use !== "function") {
        strapi.log?.warn?.(
          "[translate] strapi.documents.use is not available; auto-translate disabled"
        );
        return { installed: 0 };
      }
      strapi.documents.use(async (ctx, next) => {
        const result = await next();
        // Only run on actions that mean "the source document changed".
        if (ctx.action !== "publish" && ctx.action !== "update") return result;
        // The result of publish is an array of locales; update is a single entry.
        const resultArr = Array.isArray(result) ? result : result ? [result] : [];
        for (const entry of resultArr) {
          if (!entry || !entry.documentId || !entry.locale) continue;
          // Loop prevention: skip if we're the one who wrote this entry.
          if (inFlight.has(inFlightKey(ctx.uid, entry.documentId, entry.locale))) {
            continue;
          }
          const matching = rules.filter((r) =>
            ruleMatches(r, {
              uid: ctx.uid,
              action: ctx.action,
              locale: entry.locale,
            })
          );
          if (matching.length === 0) continue;
          // Enqueue jobs for each matching rule. Fire-and-forget; the job
          // service handles errors.
          for (const rule of matching) {
            const targets = (rule.targetLocales || []).filter(
              (l) => l !== entry.locale
            );
            if (targets.length === 0) continue;
            this.enqueue({
              uid: ctx.uid,
              documentId: entry.documentId,
              sourceLocale: entry.locale,
              targetLocales: targets,
            }).catch((err) => {
              strapi.log?.warn?.(
                `[translate] auto-translate enqueue failed: ${err?.message || err}`
              );
            });
          }
        }
        return result;
      });
      installed = true;
      strapi.log?.info?.(`[translate] auto-translate installed (${rules.length} rule(s))`);
      return { installed: rules.length };
    },

    /**
     * Enqueue an auto-translate job. Spawns work asynchronously and tracks
     * the (uid, documentId, locale) tuples it produces to prevent recursion
     * through the documents middleware.
     */
    async enqueue({ uid, documentId, sourceLocale, targetLocales }) {
      const jobs = strapi.plugin("translate").service("jobs");
      const translate = strapi.plugin("translate").service("translate");
      const job = jobs.create({
        uid,
        documentId,
        sourceLocale,
        targetLocales,
        userId: null,
        source: "auto",
      });
      job.state = "running";

      (async () => {
        for (let i = 0; i < job.targets.length; i++) {
          if (job.signal.aborted) break;
          const target = job.targets[i];
          job.activeTargetIndex = i;
          job.targetLocale = target.locale;
          target.state = "running";
          // Mark this (uid, documentId, locale) as in-flight so the
          // documents middleware doesn't re-fire on our own write.
          const key = inFlightKey(uid, documentId, target.locale);
          inFlight.add(key);
          try {
            const { entry, warnings } = await translate.translateDocument({
              uid,
              documentId,
              sourceLocale,
              targetLocale: target.locale,
              signal: job.signal,
            });
            target.state = "done";
            target.result = {
              documentId: entry.documentId,
              locale: entry.locale,
              warnings: warnings || [],
            };
          } catch (err) {
            if (err?.name === "AbortError") {
              target.state = "cancelled";
            } else {
              target.state = "failed";
              target.error = err?.message || String(err);
              strapi.log?.warn?.(
                `[translate] auto-translate ${uid}/${documentId} -> ${target.locale} failed: ${err?.message || err}`
              );
            }
          } finally {
            inFlight.delete(key);
          }
        }
        job.activeTargetIndex = -1;
        job.state = job.targets.every((t) => t.state === "done")
          ? "done"
          : job.targets.some((t) => t.state === "done")
          ? "partial"
          : job.targets.some((t) => t.state === "cancelled")
          ? "cancelled"
          : "failed";
        job.finishedAt = Date.now();
      })().catch((err) => {
        job.state = "failed";
        job.error = err?.message || String(err);
        job.finishedAt = Date.now();
      });

      return { jobId: job.id };
    },

    // Test helper.
    _isInstalled() {
      return installed;
    },
    _inFlightSet() {
      return inFlight;
    },
    _reset() {
      installed = false;
      inFlight.clear();
    },
  };
};

export { ruleMatches };
