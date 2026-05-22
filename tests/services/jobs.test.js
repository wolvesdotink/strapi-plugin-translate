import { describe, it, expect, beforeEach } from "vitest";
import factory from "../../server/services/jobs.js";

const makeStrapi = (initialStore = {}, cfg = {}) => {
  const stored = new Map();
  for (const [k, v] of Object.entries(initialStore)) {
    stored.set(k, v);
  }
  return {
    log: { warn: () => {}, info: () => {}, error: () => {} },
    store: (descriptor) => ({
      async get() {
        return stored.get(JSON.stringify(descriptor));
      },
      async set({ value }) {
        stored.set(JSON.stringify(descriptor), value);
      },
    }),
    plugin: () => ({ config: cfg }),
    _stored: stored,
  };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("jobs service", () => {
  let svc;
  beforeEach(() => {
    svc = factory({ strapi: makeStrapi({}, { persistJobs: false }) });
    svc._reset();
    svc = factory({ strapi: makeStrapi({}, { persistJobs: false }) });
  });

  it("creates a job with multi-locale targets", () => {
    const job = svc.create({
      uid: "api::page.page",
      documentId: "doc-1",
      sourceLocale: "de",
      targetLocales: ["en", "fr"],
    });
    expect(job.id).toBeTruthy();
    expect(job.targets).toHaveLength(2);
    expect(job.state).toBe("pending");
    expect(job.signal.aborted).toBe(false);
  });

  it("accepts legacy single targetLocale", () => {
    const job = svc.create({
      uid: "x",
      documentId: "d",
      targetLocale: "en",
    });
    expect(job.targets).toHaveLength(1);
    expect(job.targets[0].locale).toBe("en");
  });

  it("get() returns a snapshot, not the live record", () => {
    const job = svc.create({ uid: "x", documentId: "d", targetLocales: ["en"] });
    const snap = svc.get(job.id);
    expect(snap.id).toBe(job.id);
    expect(snap._controller).toBeUndefined();
    expect(snap.signal).toBeUndefined();
  });

  it("cancel() aborts the controller", () => {
    const job = svc.create({ uid: "x", documentId: "d", targetLocales: ["en"] });
    const res = svc.cancel(job.id);
    expect(res.ok).toBe(true);
    expect(job.signal.aborted).toBe(true);
  });

  it("cancel() returns not-found for unknown job", () => {
    const res = svc.cancel("nope");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not-found");
  });

  it("cancel() returns already-terminal for done jobs", () => {
    const job = svc.create({ uid: "x", documentId: "d", targetLocales: ["en"] });
    job.state = "done";
    job.finishedAt = Date.now();
    const res = svc.cancel(job.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("already-terminal");
  });

  it("supports bulk documents shape", () => {
    const job = svc.create({
      uid: "api::page.page",
      documentId: null,
      targetLocales: ["en", "fr"],
      documents: [
        { documentId: "a" },
        { documentId: "b" },
      ],
    });
    expect(job.documents).toHaveLength(2);
    expect(job.documents[0].targets).toHaveLength(2);
    const snap = svc.get(job.id);
    expect(snap.documents[0].documentId).toBe("a");
  });

  describe("restoreFromStore", () => {
    it("marks in-flight jobs as failed with lost-on-restart", async () => {
      const persistedKey = JSON.stringify({ type: "plugin", name: "translate", key: "jobs" });
      const recent = Date.now();
      const stored = new Map([
        [
          persistedKey,
          {
            "job-1": {
              id: "job-1",
              state: "running",
              targets: [{ locale: "en", state: "running", progress: {} }],
              startedAt: recent,
            },
            "job-2": {
              id: "job-2",
              state: "done",
              targets: [{ locale: "en", state: "done", progress: {} }],
              startedAt: recent,
              finishedAt: recent,
            },
          },
        ],
      ]);
      const strapi = {
        log: { warn: () => {}, info: () => {}, error: () => {} },
        store: () => ({
          async get() {
            return stored.get(persistedKey);
          },
          async set() {},
        }),
        plugin: () => ({ config: {} }),
      };
      const s = factory({ strapi });
      s._reset();
      const s2 = factory({ strapi });
      const res = await s2.restoreFromStore();
      expect(res.recovered).toBe(2);
      expect(res.marked).toBe(1);
      const job1 = s2.get("job-1");
      const job2 = s2.get("job-2");
      expect(job1.state).toBe("failed");
      expect(job1.error).toBe("lost-on-restart");
      expect(job2.state).toBe("done");
    });

    it("is a no-op when persistJobs is disabled", async () => {
      const stored = new Map();
      const strapi = {
        log: { warn: () => {}, info: () => {}, error: () => {} },
        store: () => ({ async get() { return null; }, async set() {} }),
        plugin: () => ({ config: { persistJobs: false } }),
      };
      const s = factory({ strapi });
      const res = await s.restoreFromStore();
      expect(res.recovered).toBe(0);
    });
  });
});
