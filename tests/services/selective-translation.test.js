import { describe, it, expect } from "vitest";
import fieldsFactory from "../../server/services/translatable-fields.js";
import {
  snapshot,
  operations,
  align,
  clone,
  fingerprint,
} from "../../server/services/content-tree.js";
import {
  mergePatch,
  selectedPaths,
  previewModules,
} from "../../server/services/patch.js";
import changesFactory from "../../server/services/changes.js";

const text = {
  type: "string",
  pluginOptions: {
    translate: { translate: "translate" },
    i18n: { localized: true },
  },
};
const models = {
  page: {
    kind: "collectionType",
    pluginOptions: { i18n: { localized: true } },
    attributes: {
      title: text,
      shared: { type: "integer" },
      modules: {
        type: "dynamiczone",
        components: ["hero", "articles"],
        pluginOptions: { i18n: { localized: true } },
      },
    },
  },
  hero: {
    modelType: "component",
    info: { displayName: "Hero" },
    attributes: { title: text, description: text, hidden: { type: "string" } },
  },
  container: {
    modelType: "component",
    info: { displayName: "Container" },
    attributes: {
      children: { type: "component", repeatable: true, component: "hero" },
    },
  },
  articles: {
    modelType: "component",
    info: { displayName: "Articles" },
    attributes: {
      title: text,
      items: {
        type: "relation",
        relation: "oneToMany",
        target: "article",
        pluginOptions: { translate: { translate: "copy" } },
      },
    },
  },
  article: {
    kind: "collectionType",
    pluginOptions: { i18n: { localized: true } },
    attributes: { title: text },
  },
};
const strapi = {
  getModel: (uid) => models[uid],
  plugin: () => ({ service: () => fieldsFactory({ strapi }) }),
};
const source = {
  id: 1,
  title: "Seite",
  shared: 7,
  modules: [
    {
      id: 1,
      __component: "hero",
      title: "Hallo",
      description: "Text",
      hidden: "Source hidden",
    },
    {
      id: 2,
      __component: "articles",
      title: "Artikel",
      items: [{ documentId: "a", locale: "de" }],
    },
  ],
};
const target = {
  id: 4,
  title: "Page",
  shared: 7,
  modules: [
    {
      id: 20,
      __component: "hero",
      title: "Hello",
      description: "Editor copy",
      hidden: "Keep me",
    },
    {
      id: 30,
      __component: "articles",
      title: "Articles",
      items: [{ documentId: "a", locale: "en" }],
    },
  ],
};
const prepare = (before, after, currentTarget = target) => {
  const a = snapshot(strapi, "page", before),
    b = snapshot(strapi, "page", after),
    t = snapshot(strapi, "page", currentTarget);
  return {
    uid: "page",
    documentId: "doc",
    sourceLocale: "de",
    targetLocale: "en",
    source: after,
    target: currentTarget,
    before: a,
    current: b,
    targetTree: t,
    mapping: align(a, t).mapping,
    ops: operations(a, b),
  };
};

describe("selective content identity and patching", () => {
  it("ignores managed keys and nonlocalized/skip fields", () => {
    const edited = clone(source);
    edited.updatedAt = "new";
    edited.shared = 9;
    edited.modules[0].hidden = "changed";
    expect(
      operations(
        snapshot(strapi, "page", source),
        snapshot(strapi, "page", edited),
      ),
    ).toEqual([]);
  });
  it("uses canonical object fingerprints and keeps array order significant", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });
  it("collects explicit clears and sends only the changed field", () => {
    const edited = clone(source);
    edited.modules[0].title = "";
    const prepared = prepare(source, edited);
    expect(selectedPaths(prepared)).toEqual(["modules.0.title"]);
    const data = mergePatch(strapi, prepared, { modules: [{ title: "" }] });
    expect(data.modules[0]).toMatchObject({
      id: 20,
      title: "",
      description: "Editor copy",
      hidden: "Keep me",
    });
    expect(data.title).toBeUndefined();
    expect(data.modules[1].items).toEqual(["a"]);
  });
  it("maps a field edit to the matching target module even when target order differs", () => {
    const edited = clone(source);
    edited.modules[0].title = "Neu";
    const reversed = {
      ...clone(target),
      modules: clone(target.modules).reverse(),
    };
    const prepared = prepare(source, edited, reversed);
    const data = mergePatch(strapi, prepared, { modules: [{ title: "New" }] });
    expect(data.modules[0].title).toBe("Articles");
    expect(data.modules[1].title).toBe("New");
    expect(data.modules[1].id).toBe(20);
  });
  it("moves mapped modules while retaining target-only components", () => {
    const edited = {
      ...clone(source),
      modules: clone(source.modules).reverse(),
    };
    const extra = {
      ...clone(target),
      modules: [
        target.modules[0],
        {
          id: 21,
          __component: "hero",
          title: "Target only",
          description: "Preserved",
        },
        target.modules[1],
      ],
    };
    const prepared = prepare(source, edited, extra);
    // Existing established correspondence avoids ambiguity from target-only items.
    prepared.mapping = {
      root: "root",
      "root/modules:hero:1": "root/modules:hero:20",
      "root/modules:articles:2": "root/modules:articles:30",
    };
    expect(prepared.ops).toHaveLength(1);
    expect(selectedPaths(prepared)).toEqual([]);
    const data = mergePatch(strapi, prepared, {});
    expect(data.modules.map((m) => m.id)).toEqual([30, 21, 20]);
    expect(data.modules[2].description).toBe("Editor copy");
  });
  it("inserts new modules without source IDs and removes only mapped modules", () => {
    const edited = clone(source);
    edited.modules.splice(1, 0, {
      id: 3,
      __component: "hero",
      title: "Neu",
      description: "Neu Text",
    });
    const prepared = prepare(source, edited);
    expect(selectedPaths(prepared)).toEqual([
      "modules.1.title",
      "modules.1.description",
    ]);
    const computed = {
      modules: [
        null,
        { __component: "hero", title: "New", description: "New text" },
      ],
    };
    const data = mergePatch(strapi, prepared, computed);
    expect(data.modules[1]).toEqual({
      __component: "hero",
      title: "New",
      description: "New text",
    });
    expect(data.modules[2].id).toBe(30);
    const cards = previewModules(prepared, data, prepared.ops);
    expect(
      cards
        .flatMap((card) => card.fields)
        .find((f) => f.kind === "inserted-field" && f.name === "title"),
    ).toMatchObject({
      source: "Neu",
      after: "New",
      operationId: "root/modules",
    });
    const removed = clone(source);
    removed.modules.shift();
    const removal = prepare(source, removed);
    expect(mergePatch(strapi, removal, {}).modules.map((m) => m.id)).toEqual([
      30,
    ]);
  });
  it("requires explicit alignment for duplicate component types", () => {
    const duplicateSource = clone(source);
    duplicateSource.modules.push({
      id: 3,
      __component: "hero",
      title: "Two",
      description: "Second",
    });
    const duplicateTarget = clone(target);
    duplicateTarget.modules.push({
      id: 21,
      __component: "hero",
      title: "Two",
      description: "Second",
    });
    const a = snapshot(strapi, "page", duplicateSource),
      b = snapshot(strapi, "page", duplicateTarget);
    expect(align(a, b).unresolved).toHaveLength(2);
    const explicit = {
      "root/modules:hero:1": "root/modules:hero:20",
      "root/modules:hero:3": "root/modules:hero:21",
    };
    expect(align(a, b, {}, explicit).unresolved).toEqual([]);
    expect(() =>
      align(
        a,
        b,
        {},
        { ...explicit, "root/modules:hero:3": "root/modules:hero:20" },
      ),
    ).toThrow("same target module");
  });
  it("uses application translationKey values to align duplicate types", () => {
    const a = clone(source),
      b = clone(target);
    a.modules[0].translationKey = "hero-one";
    b.modules[0].translationKey = "hero-one";
    a.modules.push({
      id: 3,
      __component: "hero",
      translationKey: "hero-two",
      title: "Two",
    });
    b.modules.unshift({
      id: 21,
      __component: "hero",
      translationKey: "hero-two",
      title: "Two",
    });
    expect(
      align(snapshot(strapi, "page", a), snapshot(strapi, "page", b))
        .unresolved,
    ).toEqual([]);
  });
  it("does not advance an excluded text change when accepting a module reorder", async () => {
    const edited = {
      ...clone(source),
      modules: clone(source.modules).reverse(),
    };
    edited.modules[1].title = "New source";
    const prepared = prepare(source, edited);
    const state = new Map();
    const fakeState = {
      key: (...parts) => JSON.stringify(parts),
      read: async (k) => state.get(k),
      write: async (k, v) => state.set(k, clone(v)),
    };
    const fake = {
      ...strapi,
      plugin: () => ({
        service: (name) =>
          name === "state" ? fakeState : fieldsFactory({ strapi }),
      }),
    };
    const changes = changesFactory({ strapi: fake });
    const accepted = prepared.ops.filter((op) => op.kind === "structure");
    await changes.applied(prepared, accepted, target);
    const baseline = [...state.values()][0].snapshot;
    const pending = operations(baseline, prepared.current);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: "field",
      name: "title",
      value: "New source",
    });
  });
  it("keeps target child correspondence after moving a differently ordered subtree", async () => {
    const before = {
      modules: [
        {
          id: 1,
          __component: "container",
          children: [
            { id: 2, translationKey: "a", title: "A" },
            { id: 3, translationKey: "b", title: "B" },
          ],
        },
        { id: 4, __component: "articles", title: "Articles" },
      ],
    };
    const currentTarget = {
      modules: [
        {
          id: 10,
          __component: "container",
          children: [
            { id: 30, translationKey: "b", title: "Manual B" },
            { id: 20, translationKey: "a", title: "Manual A" },
          ],
        },
        { id: 40, __component: "articles", title: "Manual articles" },
      ],
    };
    const after = { modules: clone(before.modules).reverse() };
    const prepared = prepare(before, after, currentTarget);
    const data = mergePatch(strapi, prepared, {});
    expect(data.modules[1].children.map((child) => child.id)).toEqual([30, 20]);
    expect(
      prepared.appliedPaths["root/modules:container:1/children:hero:a"],
    ).toEqual(["modules", 1, "children", 1]);

    let baseline;
    const fakeState = {
      key: () => "baseline",
      read: async () => baseline,
      write: async (_key, value) => {
        baseline = clone(value);
      },
    };
    const changes = changesFactory({
      strapi: {
        ...strapi,
        plugin: () => ({
          service: (name) =>
            name === "state" ? fakeState : fieldsFactory({ strapi }),
        }),
      },
    });
    await changes.applied(prepared, prepared.ops, data);
    const next = clone(after);
    next.modules[1].children[0].title = "Changed A";
    const nextPrepared = prepare(after, next, data);
    nextPrepared.mapping = align(
      nextPrepared.before,
      nextPrepared.targetTree,
      baseline.mapping,
    ).mapping;
    const changed = mergePatch(strapi, nextPrepared, {
      modules: [null, { children: [{ title: "Translated A" }] }],
    });
    expect(changed.modules[1].children.map((child) => child.title)).toEqual([
      "Manual B",
      "Translated A",
    ]);
  });
  it("strips initial source identities without losing writable relation commands", () => {
    const prepared = prepare(source, source);
    prepared.initialTranslation = true;
    const computed = {
      id: 1,
      documentId: "source",
      createdAt: "source-time",
      updatedAt: "source-time",
      title: "Translated",
      modules: [
        {
          id: 2,
          __component: "articles",
          title: "Translated articles",
          items: { set: ["a"] },
        },
      ],
    };
    expect(mergePatch(strapi, prepared, computed)).toEqual({
      title: "Translated",
      modules: [
        {
          __component: "articles",
          title: "Translated articles",
          items: { set: ["a"] },
        },
      ],
    });
  });
});
