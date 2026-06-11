// In-memory registry of in-flight translation jobs.
//
// The controller hands off a long-running translation to the service and
// returns a jobId immediately. The admin UI polls GET /translate/jobs/:id
// for progress and POSTs /translate/jobs/:id/cancel to abort.
//
// A single job can fan out across multiple target locales: `targets` is an
// ordered list and the controller iterates it sequentially. The legacy
// top-level fields (`targetLocale`, `progress`, `result`) mirror whichever
// target is currently active so older snapshot consumers keep working.
//
// Persistence: jobs are written through to strapi.store on every state
// change (debounced). On bootstrap, any job in running/pending is marked
// `failed` with `error: "lost-on-restart"` and surfaced so the UI can show
// "your translation didn't finish — please retry". Restart recovery lives
// in this service so bootstrap.js stays trivial.

const STORE_KEY = { type: "plugin", name: "translate", key: "jobs" };

const TERMINAL_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "partial"]);

const jobs = new Map();

let strapiRef = null;
let persistTimer = null;
const PERSIST_DEBOUNCE_MS = 250;

const emptyFormatProgress = () => ({
  plain: { done: 0, total: 0 },
  html: { done: 0, total: 0 },
  blocks: { done: 0, total: 0 },
});

const isPersistEnabled = () => {
  if (!strapiRef) return false;
  const cfg = strapiRef.plugin?.("translate")?.config || {};
  if (cfg.persistJobs === false) return false;
  return true;
};

const snapshot = (job) => ({
  id: job.id,
  state: job.state,
  progress: job.progress,
  error: job.error || null,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt || null,
  uid: job.uid,
  documentId: job.documentId,
  sourceLocale: job.sourceLocale,
  // Legacy single-locale field — mirrors the active (or last-active) target.
  targetLocale: job.targetLocale,
  result: job.result || null,
  // Multi-locale fields.
  targets: job.targets.map((t) => ({
    locale: t.locale,
    state: t.state,
    progress: t.progress,
    error: t.error || null,
    result: t.result || null,
  })),
  activeTargetIndex: job.activeTargetIndex,
  // Bulk fan-out (documents × locales). Optional — only present when set.
  documents: job.documents ? job.documents.map((d) => ({
    documentId: d.documentId,
    state: d.state,
    error: d.error || null,
    targets: d.targets.map((t) => ({
      locale: t.locale,
      state: t.state,
      progress: t.progress,
      error: t.error || null,
      result: t.result || null,
    })),
  })) : undefined,
  // Provenance flag — auto-translate populates this.
  source: job.source || "manual",
});

// Strip non-serializable bits (AbortController) before persisting.
const persistableSnapshot = (job) => {
  const snap = snapshot(job);
  return snap;
};

const persist = () => {
  if (!isPersistEnabled()) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const all = {};
      for (const [id, job] of jobs) {
        all[id] = persistableSnapshot(job);
      }
      await strapiRef.store(STORE_KEY).set({ value: all });
    } catch (err) {
      strapiRef.log?.warn?.(`[translate] failed to persist jobs: ${err?.message || err}`);
    }
  }, PERSIST_DEBOUNCE_MS);
};

const cleanupExpired = () => {
  const now = Date.now();
  let changed = false;
  for (const [id, job] of jobs) {
    if (
      TERMINAL_STATES.has(job.state) &&
      job.finishedAt &&
      now - job.finishedAt > TERMINAL_TTL_MS
    ) {
      jobs.delete(id);
      changed = true;
    }
  }
  if (changed) persist();
};

export default ({ strapi }) => {
  strapiRef = strapi;
  return {
    // Recover persisted jobs from the store. Any in-flight (`pending` /
    // `running`) state is impossible after a restart — mark them `failed`.
    async restoreFromStore() {
      if (!isPersistEnabled()) return { recovered: 0, marked: 0 };
      let data;
      try {
        data = await strapi.store(STORE_KEY).get();
      } catch (err) {
        strapi.log?.warn?.(
          `[translate] failed to read jobs from store: ${err?.message || err}`
        );
        return { recovered: 0, marked: 0 };
      }
      if (!data || typeof data !== "object") return { recovered: 0, marked: 0 };
      const now = Date.now();
      let recovered = 0;
      let marked = 0;
      for (const [id, snap] of Object.entries(data)) {
        if (!snap || typeof snap !== "object") continue;
        const wasInflight = snap.state === "pending" || snap.state === "running";
        const targets = (snap.targets || []).map((t) => ({
          locale: t.locale,
          state: wasInflight && (t.state === "pending" || t.state === "running")
            ? "failed"
            : t.state || "failed",
          progress: t.progress || emptyFormatProgress(),
          error:
            wasInflight && (t.state === "pending" || t.state === "running")
              ? t.error || "lost-on-restart"
              : t.error || null,
          result: t.result || null,
        }));
        const job = {
          id,
          uid: snap.uid,
          documentId: snap.documentId,
          sourceLocale: snap.sourceLocale,
          userId: null,
          targetLocale: snap.targetLocale,
          progress: snap.progress || emptyFormatProgress(),
          result: snap.result || null,
          targets,
          documents: snap.documents,
          activeTargetIndex: -1,
          state: wasInflight ? "failed" : snap.state,
          error: wasInflight ? "lost-on-restart" : snap.error || null,
          startedAt: snap.startedAt || now,
          finishedAt: wasInflight ? now : snap.finishedAt || now,
          signal: { aborted: true },
          abort: () => {},
          _controller: { signal: { aborted: true }, abort: () => {} },
          source: snap.source || "manual",
        };
        jobs.set(id, job);
        recovered += 1;
        if (wasInflight) marked += 1;
      }
      if (recovered > 0) {
        strapi.log?.info?.(
          `[translate] recovered ${recovered} job(s) from store (${marked} marked as failed/lost-on-restart)`
        );
        persist();
      }
      return { recovered, marked };
    },

    // Returns the live job record (a reference, not a copy) so the controller
    // can mutate state/progress/targets on it as the translation runs.
    // Accepts either `targetLocales: string[]` or legacy `targetLocale: string`.
    create({ uid, documentId, sourceLocale, targetLocale, targetLocales, userId, documents, source }) {
      cleanupExpired();
      const controller = new AbortController();
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

      const locales = Array.isArray(targetLocales) && targetLocales.length
        ? targetLocales.slice()
        : targetLocale
        ? [targetLocale]
        : [];

      const targets = locales.map((locale) => ({
        locale,
        state: "pending",
        progress: emptyFormatProgress(),
        error: null,
        result: null,
      }));

      // Bulk shape: an array of documents, each with its own target list.
      // Used by /translate/bulk. When present, `targets` mirrors the union
      // of all per-doc target locales for legacy snapshot consumers.
      const docsField = Array.isArray(documents) && documents.length
        ? documents.map((d) => ({
            documentId: d.documentId,
            state: "pending",
            error: null,
            targets: locales.map((locale) => ({
              locale,
              state: "pending",
              progress: emptyFormatProgress(),
              error: null,
              result: null,
            })),
          }))
        : undefined;

      const job = {
        id,
        uid,
        documentId,
        sourceLocale,
        userId: userId || null,
        // Top-level mirrors of the active target (legacy snapshot shape).
        targetLocale: locales[0] || null,
        progress: emptyFormatProgress(),
        result: null,
        // Multi-locale fan-out.
        targets,
        documents: docsField,
        activeTargetIndex: -1,
        state: "pending",
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
        signal: controller.signal,
        abort: (reason) => {
          controller.abort(reason);
          persist();
        },
        _controller: controller,
        source: source || "manual",
      };
      jobs.set(id, job);
      persist();
      return job;
    },

    // Public snapshot for API responses — strips internals like the controller.
    get(id) {
      cleanupExpired();
      const job = jobs.get(id);
      return job ? snapshot(job) : null;
    },

    list() {
      cleanupExpired();
      return [...jobs.values()].map(snapshot);
    },

    cancel(id) {
      cleanupExpired();
      const job = jobs.get(id);
      if (!job) return { ok: false, reason: "not-found" };
      if (TERMINAL_STATES.has(job.state)) {
        return { ok: false, reason: "already-terminal", state: job.state };
      }
      job._controller.abort();
      persist();
      return { ok: true };
    },

    // Called after the controller's run loop finishes (per-document or
    // bulk) so we flush the final state synchronously.
    persistNow() {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (!isPersistEnabled()) return Promise.resolve();
      const all = {};
      for (const [id, job] of jobs) {
        all[id] = persistableSnapshot(job);
      }
      return strapiRef.store(STORE_KEY).set({ value: all });
    },

    // Used by tests to wipe in-memory state.
    _reset() {
      jobs.clear();
      strapiRef = null;
    },
  };
};
