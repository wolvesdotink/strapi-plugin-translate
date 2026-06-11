import { describe, it, expect } from "vitest";
import factory, { diff } from "../../server/services/preview.js";

describe("preview.diff", () => {
  it("returns empty for equal objects", () => {
    expect(diff({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("detects scalar changes", () => {
    const d = diff({ title: "Hallo" }, { title: "Hello" });
    expect(d).toEqual([{ path: "title", before: "Hallo", after: "Hello" }]);
  });

  it("recurses into nested objects", () => {
    const d = diff(
      { hero: { heading: "Hallo Welt" } },
      { hero: { heading: "Hello world" } }
    );
    expect(d).toEqual([
      { path: "hero.heading", before: "Hallo Welt", after: "Hello world" },
    ]);
  });

  it("walks arrays by index", () => {
    const d = diff(["a", "b"], ["a", "B"]);
    expect(d).toEqual([{ path: "1", before: "b", after: "B" }]);
  });

  it("reports key additions and removals", () => {
    const d = diff({ a: 1 }, { b: 2 });
    expect(d).toHaveLength(2);
    expect(d.find((e) => e.path === "a")).toMatchObject({ before: 1, after: undefined });
    expect(d.find((e) => e.path === "b")).toMatchObject({ before: undefined, after: 2 });
  });

  it("handles null/undefined transitions", () => {
    const d = diff({ a: null }, { a: "x" });
    expect(d).toEqual([{ path: "a", before: null, after: "x" }]);
  });

  it("skips Strapi system keys at the root", () => {
    const existing = {
      id: 42,
      documentId: "doc1",
      locale: "en",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-02",
      publishedAt: "2024-01-03",
      createdBy: { id: 1 },
      updatedBy: { id: 1 },
      localizations: [{ id: 7, locale: "de" }],
      title: "Hallo",
    };
    const proposed = { title: "Hello" };
    expect(diff(existing, proposed)).toEqual([
      { path: "title", before: "Hallo", after: "Hello" },
    ]);
  });

  it("skips system keys nested inside components", () => {
    const existing = {
      hero: { id: 5, heading: "Hallo", __component: "blocks.hero" },
    };
    const proposed = {
      hero: { heading: "Hello", __component: "blocks.hero" },
    };
    expect(diff(existing, proposed)).toEqual([
      { path: "hero.heading", before: "Hallo", after: "Hello" },
    ]);
  });
});

describe("preview service lifecycle", () => {
  const makeStrapi = (translateMock, existingTarget) => {
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
      documents: () => ({
        async findOne() {
          return existingTarget;
        },
      }),
      plugin: () => ({
        service: (n) => {
          if (n === "translate") return translateMock;
          return null;
        },
      }),
      _stored: stored,
    };
  };

  it("create -> get -> discard removes the preview", async () => {
    const translateMock = {
      translateDocumentDry: async () => ({
        proposed: { title: "Hello" },
        warnings: [],
      }),
      commitPreview: async () => ({ documentId: "d", locale: "en", title: "Hello" }),
    };
    const strapi = makeStrapi(translateMock, { title: "Hallo" });
    const svc = factory({ strapi });
    const out = await svc.create({
      uid: "api::page.page",
      documentId: "d",
      sourceLocale: "de",
      targetLocale: "en",
    });
    expect(out.previewId).toBeTruthy();
    expect(out.diff[0]).toMatchObject({ path: "title", before: "Hallo", after: "Hello" });
    const got = await svc.get(out.previewId);
    expect(got.proposed.title).toBe("Hello");
    const res = await svc.discard(out.previewId);
    expect(res.ok).toBe(true);
    const after = await svc.get(out.previewId);
    expect(after).toBeNull();
  });

  it("accept calls translate.commitPreview and removes the preview", async () => {
    let committed = null;
    const translateMock = {
      translateDocumentDry: async () => ({ proposed: { title: "Hi" }, warnings: [] }),
      commitPreview: async (args) => {
        committed = args;
        return { documentId: args.documentId, locale: args.targetLocale, ...args.proposed };
      },
    };
    const strapi = makeStrapi(translateMock, null);
    const svc = factory({ strapi });
    const out = await svc.create({
      uid: "api::page.page",
      documentId: "d",
      sourceLocale: "de",
      targetLocale: "en",
    });
    const accept = await svc.accept(out.previewId);
    expect(accept.ok).toBe(true);
    expect(committed.proposed.title).toBe("Hi");
    const gone = await svc.get(out.previewId);
    expect(gone).toBeNull();
  });

  it("accept with excludedPaths keeps the current value for those fields", async () => {
    let committed = null;
    const translateMock = {
      translateDocumentDry: async () => ({
        proposed: { title: "Hello", body: "World" },
        warnings: [],
        translatedPaths: ["title", "body"],
      }),
      commitPreview: async (args) => {
        committed = args;
        return { documentId: args.documentId, locale: args.targetLocale };
      },
    };
    const strapi = makeStrapi(translateMock, { title: "Hallo", body: "Welt" });
    const svc = factory({ strapi });
    const out = await svc.create({
      uid: "api::page.page",
      documentId: "d",
      sourceLocale: "de",
      targetLocale: "en",
    });
    const accept = await svc.accept(out.previewId, {
      excludedPaths: ["title"],
    });
    expect(accept.ok).toBe(true);
    // Excluded field reverted to the target locale's current value.
    expect(committed.proposed.title).toBe("Hallo");
    // Still-selected field keeps the translation.
    expect(committed.proposed.body).toBe("World");
    // The repair loop must not rewrite the kept field.
    expect(committed.translatedPaths).toEqual(["body"]);
  });

  it("accept with excludedPaths drops fields that have no current value", async () => {
    let committed = null;
    const translateMock = {
      translateDocumentDry: async () => ({
        proposed: { title: "Hello", subtitle: "New here" },
        warnings: [],
      }),
      commitPreview: async (args) => {
        committed = args;
        return { documentId: args.documentId, locale: args.targetLocale };
      },
    };
    // Target locale entry exists but has no subtitle.
    const strapi = makeStrapi(translateMock, { title: "Hallo" });
    const svc = factory({ strapi });
    const out = await svc.create({
      uid: "api::page.page",
      documentId: "d",
      sourceLocale: "de",
      targetLocale: "en",
    });
    await svc.accept(out.previewId, { excludedPaths: ["subtitle"] });
    expect("subtitle" in committed.proposed).toBe(false);
    expect(committed.proposed.title).toBe("Hello");
  });

  it("accept with excludedPaths splices excluded new array elements", async () => {
    let committed = null;
    const translateMock = {
      translateDocumentDry: async () => ({
        proposed: { items: [{ label: "One" }, { label: "Two" }] },
        warnings: [],
      }),
      commitPreview: async (args) => {
        committed = args;
        return { documentId: args.documentId, locale: args.targetLocale };
      },
    };
    // Target currently has only the first item.
    const strapi = makeStrapi(translateMock, { items: [{ label: "Eins" }] });
    const svc = factory({ strapi });
    const out = await svc.create({
      uid: "api::page.page",
      documentId: "d",
      sourceLocale: "de",
      targetLocale: "en",
    });
    // diff reports items.0.label (changed) and items.1 (added)
    await svc.accept(out.previewId, { excludedPaths: ["items.1"] });
    expect(committed.proposed.items).toEqual([{ label: "One" }]);
  });

  it("accept ignores excludedPaths that are not part of the diff", async () => {
    let committed = null;
    const translateMock = {
      translateDocumentDry: async () => ({
        proposed: { title: "Hello" },
        warnings: [],
      }),
      commitPreview: async (args) => {
        committed = args;
        return { documentId: args.documentId, locale: args.targetLocale };
      },
    };
    const strapi = makeStrapi(translateMock, { title: "Hallo" });
    const svc = factory({ strapi });
    const out = await svc.create({
      uid: "api::page.page",
      documentId: "d",
      sourceLocale: "de",
      targetLocale: "en",
    });
    await svc.accept(out.previewId, {
      excludedPaths: ["nope", "createdBy", "__proto__.polluted"],
    });
    expect(committed.proposed.title).toBe("Hello");
    expect({}.polluted).toBeUndefined();
  });

  it("a failed accept with excludedPaths leaves the stored payload intact", async () => {
    let calls = 0;
    const translateMock = {
      translateDocumentDry: async () => ({
        proposed: { title: "Hello" },
        warnings: [],
      }),
      commitPreview: async (args) => {
        calls += 1;
        if (calls === 1) throw new Error("validation failed");
        return { documentId: args.documentId, locale: args.targetLocale };
      },
    };
    const strapi = makeStrapi(translateMock, { title: "Hallo" });
    const svc = factory({ strapi });
    const out = await svc.create({
      uid: "api::page.page",
      documentId: "d",
      sourceLocale: "de",
      targetLocale: "en",
    });
    await expect(
      svc.accept(out.previewId, { excludedPaths: ["title"] })
    ).rejects.toThrow("validation failed");
    // The stored preview must still hold the untouched translation so a
    // retry with a different selection starts from the original.
    const row = await svc.get(out.previewId);
    expect(row.proposed.title).toBe("Hello");
  });

  it("returns not-found for unknown preview ids", async () => {
    const translateMock = {
      translateDocumentDry: async () => ({ proposed: {}, warnings: [] }),
      commitPreview: async () => ({}),
    };
    const svc = factory({ strapi: makeStrapi(translateMock, null) });
    expect(await svc.discard("nope")).toEqual({ ok: false, reason: "not-found" });
    expect(await svc.accept("nope")).toEqual({ ok: false, reason: "not-found" });
  });
});
