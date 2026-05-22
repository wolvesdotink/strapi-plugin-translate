import { describe, it, expect } from "vitest";
import factory, { similarity, normalize, sampleItems } from "../../server/services/back-translate.js";

describe("back-translate helpers", () => {
  describe("normalize", () => {
    it("lowercases and strips punctuation", () => {
      expect(normalize("Hello, World!")).toBe("hello world");
    });
    it("collapses whitespace", () => {
      expect(normalize("a\t\nb")).toBe("a b");
    });
    it("preserves hyphens", () => {
      expect(normalize("co-op")).toBe("co-op");
    });
  });

  describe("similarity", () => {
    it("returns 1 for identical strings", () => {
      expect(similarity("hi", "hi")).toBe(1);
    });
    it("returns 1 for case-only differences", () => {
      expect(similarity("Hello", "hello")).toBe(1);
    });
    it("returns 0 for empty vs non-empty", () => {
      expect(similarity("", "hi")).toBe(0);
    });
    it("returns high score for near-identical", () => {
      expect(similarity("Hello world", "Hello worlds")).toBeGreaterThan(0.8);
    });
    it("returns low score for unrelated", () => {
      expect(similarity("The quick brown fox", "Tomato soup recipe")).toBeLessThan(0.5);
    });
  });

  describe("sampleItems", () => {
    it("picks longest items first", () => {
      const items = [
        { text: "short" },
        { text: "a very long string with lots of content for sampling" },
        { text: "medium length string" },
      ];
      const picked = sampleItems(items, { perGroup: 2 });
      expect(picked).toHaveLength(2);
      expect(picked[0].text).toMatch(/very long/);
    });
    it("respects perGroup limit", () => {
      const items = new Array(20).fill(null).map((_, i) => ({ text: `t-${i}` }));
      expect(sampleItems(items, { perGroup: 3 })).toHaveLength(3);
    });
  });
});

describe("back-translate service", () => {
  const makeStrapi = (translateImpl) => ({
    log: { warn: () => {}, info: () => {}, error: () => {} },
    plugin: () => ({
      provider: { translate: translateImpl },
      service: () => null,
    }),
  });

  it("returns no warnings when pairs are similar", async () => {
    const strapi = makeStrapi(async ({ text }) =>
      text.map((t) => t) // identity round-trip
    );
    const svc = factory({ strapi });
    const res = await svc.check({
      pairs: [
        { original: "hello", translated: "hello", format: "plain" },
        { original: "world", translated: "world", format: "plain" },
      ],
      sourceLocale: "en",
      targetLocale: "de",
    });
    expect(res.warnings).toHaveLength(0);
    expect(res.samples).toHaveLength(2);
    expect(res.samples[0].similarity).toBe(1);
  });

  it("flags drift when back-translation differs", async () => {
    const strapi = makeStrapi(async ({ text }) =>
      text.map(() => "completely unrelated tomato")
    );
    const svc = factory({ strapi });
    const res = await svc.check({
      pairs: [
        { original: "hello world", translated: "bonjour monde", format: "plain", label: "title" },
      ],
      sourceLocale: "en",
      targetLocale: "fr",
      threshold: 0.5,
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].label).toBe("title");
    expect(res.warnings[0].similarity).toBeLessThan(0.5);
  });

  it("returns empty when no pairs", async () => {
    const svc = factory({ strapi: makeStrapi(async () => []) });
    const res = await svc.check({ pairs: [], sourceLocale: "en", targetLocale: "de" });
    expect(res.warnings).toEqual([]);
    expect(res.samples).toEqual([]);
  });

  it("preserves order when checking", async () => {
    const strapi = makeStrapi(async ({ text }) => text.map((t) => `BACK[${t}]`));
    const svc = factory({ strapi });
    const res = await svc.check({
      pairs: [
        { original: "first", translated: "uno", format: "plain", label: "a" },
        { original: "second", translated: "dos", format: "plain", label: "b" },
      ],
      sourceLocale: "en",
      targetLocale: "es",
    });
    expect(res.samples[0].label).toBe("a");
    expect(res.samples[1].label).toBe("b");
  });
});
