import { describe, it, expect, beforeEach } from "vitest";
import factory from "../../server/services/cache.js";

const makeStrapi = (cfg = {}) => {
  const stored = new Map();
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
    plugin: () => ({
      config: cfg,
      service: () => null,
    }),
    _stored: stored,
  };
};

describe("cache service", () => {
  it("hashes consistently regardless of glossary key order", () => {
    const a = factory.hashEntry({
      source: "hi",
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
      voice: "warm",
      glossary: { preserveExact: ["A", "B"], perLocale: { en: { a: "b" } } },
    });
    const b = factory.hashEntry({
      source: "hi",
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
      voice: "warm",
      glossary: { perLocale: { en: { a: "b" } }, preserveExact: ["A", "B"] },
    });
    expect(a).toBe(b);
  });

  it("different voice produces different hash", () => {
    const base = {
      source: "hi",
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
      glossary: { preserveExact: [], perLocale: {} },
    };
    expect(factory.hashEntry({ ...base, voice: "warm" })).not.toBe(
      factory.hashEntry({ ...base, voice: "formal" })
    );
  });

  it("getMany returns miss for empty cache", async () => {
    const strapi = makeStrapi();
    const svc = factory({ strapi });
    const out = await svc.getMany([
      { source: "hi", sourceLocale: "de", targetLocale: "en", format: "plain", voice: "", glossary: {} },
    ]);
    expect(out[0].hit).toBe(false);
  });

  it("setMany then getMany returns hit", async () => {
    const strapi = makeStrapi();
    const svc = factory({ strapi });
    const entry = {
      source: "hi",
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
      voice: "",
      glossary: {},
    };
    const key = svc.keyFor(entry);
    await svc.setMany([{ key, translation: "hello" }]);
    const out = await svc.getMany([entry]);
    expect(out[0].hit).toBe(true);
    expect(out[0].translation).toBe("hello");
  });

  it("cache disabled by config returns miss always", async () => {
    const strapi = makeStrapi({ cache: { enabled: false } });
    const svc = factory({ strapi });
    const entry = {
      source: "hi",
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
      voice: "",
      glossary: {},
    };
    await svc.setMany([{ key: svc.keyFor(entry), translation: "hello" }]);
    const out = await svc.getMany([entry]);
    expect(out[0].hit).toBe(false);
  });

  it("clear() empties the cache", async () => {
    const strapi = makeStrapi();
    const svc = factory({ strapi });
    await svc.setMany([
      { key: "a".repeat(64), translation: "x" },
      { key: "b".repeat(64), translation: "y" },
    ]);
    const cleared = await svc.clear();
    expect(cleared).toBe(2);
    const stats = await svc.stats();
    expect(stats.size).toBe(0);
  });

  it("evicts oldest entries when over max", async () => {
    const strapi = makeStrapi({ cacheMaxEntries: 3 });
    const svc = factory({ strapi });
    // Write 4 entries with explicit createdAt order
    const writes = ["a", "b", "c", "d"].map((c, i) => ({
      key: c.repeat(64),
      translation: c,
    }));
    await svc.setMany(writes);
    const stats = await svc.stats();
    // After eviction (drops 500 oldest when over) we keep no more than 3.
    expect(stats.size).toBeLessThanOrEqual(3);
  });
});
