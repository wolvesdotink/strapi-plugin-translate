import { describe, it, expect } from "vitest";
import factory from "../../server/services/translatable-fields.js";

const makeStrapi = (models) => ({
  getModel: (uid) => models[uid],
  log: { warn: () => {}, info: () => {}, error: () => {} },
});

describe("translatable-fields service", () => {
  describe("describe()", () => {
    it("returns directive=copy for non-translatable scalars regardless of directive", () => {
      const models = {
        "api::page.page": {
          kind: "collectionType",
          attributes: {
            title: {
              type: "string",
              pluginOptions: { translate: { translate: "translate" } },
            },
            createdCount: {
              type: "integer",
              pluginOptions: { translate: { translate: "translate" } },
            },
            slug: {
              type: "uid",
              pluginOptions: { translate: { translate: "copy" } },
            },
            published: { type: "boolean" },
          },
        },
      };
      const svc = factory({ strapi: makeStrapi(models) });
      const desc = svc.describe("api::page.page");
      const titleAttr = desc.attributes.find((a) => a.name === "title");
      const countAttr = desc.attributes.find((a) => a.name === "createdCount");
      const slugAttr = desc.attributes.find((a) => a.name === "slug");
      const pubAttr = desc.attributes.find((a) => a.name === "published");
      expect(titleAttr.directive).toBe("translate");
      expect(titleAttr.format).toBe("plain");
      expect(countAttr.directive).toBe("copy"); // never translated
      expect(slugAttr.directive).toBe("copy");
      expect(pubAttr.directive).toBe("copy");
    });

    it("uid field with directive=translate is coerced to regenerate", () => {
      const models = {
        "api::page.page": {
          kind: "collectionType",
          attributes: {
            slug: {
              type: "uid",
              pluginOptions: { translate: { translate: "translate" } },
            },
          },
        },
      };
      const svc = factory({ strapi: makeStrapi(models) });
      const desc = svc.describe("api::page.page");
      const slug = desc.attributes.find((a) => a.name === "slug");
      expect(slug.directive).toBe("regenerate");
    });

    it("respects regenerate directive on uid field directly", () => {
      const models = {
        "api::page.page": {
          kind: "collectionType",
          attributes: {
            slug: {
              type: "uid",
              pluginOptions: { translate: { translate: "regenerate" } },
            },
          },
        },
      };
      const svc = factory({ strapi: makeStrapi(models) });
      const desc = svc.describe("api::page.page");
      expect(desc.attributes.find((a) => a.name === "slug").directive).toBe(
        "regenerate"
      );
    });

    it("skips writable:false attributes", () => {
      const models = {
        "api::page.page": {
          kind: "collectionType",
          attributes: {
            title: { type: "string" },
            localizations: { type: "relation", writable: false },
          },
        },
      };
      const svc = factory({ strapi: makeStrapi(models) });
      const desc = svc.describe("api::page.page");
      expect(desc.attributes.find((a) => a.name === "localizations")).toBeUndefined();
    });

    it("components default to translate (recurse)", () => {
      const models = {
        "api::page.page": {
          kind: "collectionType",
          attributes: {
            hero: { type: "component", component: "blocks.hero" },
          },
        },
      };
      const svc = factory({ strapi: makeStrapi(models) });
      const desc = svc.describe("api::page.page");
      const hero = desc.attributes.find((a) => a.name === "hero");
      expect(hero.directive).toBe("translate");
      expect(hero.component).toBe("blocks.hero");
    });

    it("falls back to legacy flat translate annotation", () => {
      const models = {
        "api::page.page": {
          kind: "collectionType",
          attributes: {
            legacy: { type: "string", translate: "copy" },
          },
        },
      };
      const svc = factory({ strapi: makeStrapi(models) });
      const desc = svc.describe("api::page.page");
      expect(desc.attributes.find((a) => a.name === "legacy").directive).toBe("copy");
    });

    it("throws on unknown model", () => {
      const svc = factory({ strapi: makeStrapi({}) });
      expect(() => svc.describe("api::missing.missing")).toThrow(/unknown model/);
    });
  });

  describe("buildPopulate()", () => {
    it("recurses through components and dynamic zones", () => {
      const models = {
        "api::page.page": {
          kind: "collectionType",
          attributes: {
            title: { type: "string" },
            cover: { type: "media" },
            hero: { type: "component", component: "blocks.hero" },
            sections: {
              type: "dynamiczone",
              components: ["blocks.text", "blocks.gallery"],
            },
            author: { type: "relation", relation: "manyToOne", target: "admin::user" },
          },
        },
        "blocks.hero": {
          kind: "component",
          attributes: {
            heading: { type: "string" },
            image: { type: "media" },
          },
        },
        "blocks.text": {
          kind: "component",
          attributes: { body: { type: "richtext" } },
        },
        "blocks.gallery": {
          kind: "component",
          attributes: { images: { type: "media" } },
        },
      };
      const svc = factory({ strapi: makeStrapi(models) });
      const populate = svc.buildPopulate("api::page.page");
      expect(populate.cover).toBe(true);
      expect(populate.author).toBe(true);
      expect(populate.hero.populate.image).toBe(true);
      expect(populate.sections.on["blocks.text"].populate.body).toBeUndefined(); // richtext has no nested populate
      expect(populate.sections.on["blocks.gallery"].populate.images).toBe(true);
    });

    it("respects maxDepth to avoid infinite recursion", () => {
      const models = {
        "api::page.page": {
          kind: "collectionType",
          attributes: { sub: { type: "component", component: "blocks.recursive" } },
        },
        "blocks.recursive": {
          kind: "component",
          attributes: { inner: { type: "component", component: "blocks.recursive" } },
        },
      };
      const svc = factory({ strapi: makeStrapi(models) });
      const populate = svc.buildPopulate("api::page.page", 0, 2);
      // depth-bounded — eventually returns `true`
      const dive = populate.sub.populate.inner.populate;
      expect(dive === true || typeof dive === "object").toBe(true);
    });
  });
});
