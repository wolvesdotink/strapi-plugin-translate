"use strict";

// Walks Strapi schemas and returns a flat list describing every field's
// translation directive. Handles both annotation styles seen in this project:
//   modern: pluginOptions.translate.translate
//   legacy: attribute.translate (flat) — kept for forward compatibility
//
// Returned shape:
//   { path, type, format, directive, attr, ...meta }
//   directive in { 'translate', 'copy', 'delete', 'skip' }
//   format in { 'plain', 'html', 'blocks' } for translate-eligible fields
//
// For component / dynamiczone fields we DO NOT pre-flatten — those are walked
// at runtime (per-entry) because dynamiczones contain a mix of components
// chosen at write time, identified by `__component` on each item.

/**
 * @typedef {"translate" | "copy" | "skip" | "delete" | "regenerate"} Directive
 *
 * @typedef {object} AttrDescriptor
 * @property {string} name
 * @property {string} type
 * @property {Directive} directive
 * @property {"plain" | "html" | "blocks"} [format]
 * @property {string} [component]
 * @property {boolean} [repeatable]
 * @property {string[]} [components]
 * @property {string} [relation]
 * @property {string} [target]
 */

const SCALAR_TYPES = new Set([
  "string",
  "text",
  "richtext",
  "blocks",
  "uid",
  "email",
  "password",
  "enumeration",
  "json",
  "integer",
  "biginteger",
  "decimal",
  "float",
  "boolean",
  "date",
  "datetime",
  "time",
  "timestamp",
]);

const getDirective = (attr) => {
  // Modern (Fekide-style)
  const modern = attr?.pluginOptions?.translate?.translate;
  if (modern) return modern;
  // Legacy flat
  if (typeof attr?.translate === "string") return attr.translate;
  return null;
};

const formatFor = (type) => {
  if (type === "richtext") return "html";
  if (type === "blocks") return "blocks";
  return "plain";
};

// For a content type or component schema, return per-attribute records.
// Component / dynamiczone get a 'recurse' flag — caller walks them at runtime.
const describeAttributes = (schema) => {
  const out = [];
  if (!schema || !schema.attributes) return out;

  for (const [name, attr] of Object.entries(schema.attributes)) {
    // Skip non-writable system attributes (e.g. the i18n-injected `localizations`
    // virtual relation). Walking it leaks documentIds into data.localizations,
    // which makes Strapi's oneToMany-joinColumn handler emit
    // `UPDATE <table> SET document_id = NULL WHERE document_id = <numeric id>`,
    // breaking on MariaDB strict-mode DECIMAL coercion of VARCHAR document_ids.
    if (attr.writable === false) continue;

    const directive = getDirective(attr) || "skip";
    const type = attr.type;

    if (type === "component") {
      out.push({
        name,
        type,
        // Containers default to "translate" (recurse). Inner fields still
        // independently default to "skip", so nothing leaks to the LLM.
        directive: getDirective(attr) || "translate",
        component: attr.component,
        repeatable: !!attr.repeatable,
      });
      continue;
    }
    if (type === "dynamiczone") {
      out.push({
        name,
        type,
        directive: getDirective(attr) || "translate",
        components: attr.components || [],
      });
      continue;
    }
    if (type === "relation") {
      out.push({
        name,
        type,
        directive,
        relation: attr.relation,
        target: attr.target,
      });
      continue;
    }
    if (type === "media") {
      out.push({ name, type, directive });
      continue;
    }
    if (SCALAR_TYPES.has(type)) {
      // Only string/text/richtext/blocks should ever be translated. For
      // everything else default to 'copy' regardless of directive (numbers,
      // dates, enums must not be sent to the LLM).
      const isTranslatable = ["string", "text", "richtext", "blocks"].includes(
        type
      );
      // UID fields can never be safely translated (translating a slug breaks
      // URL routing). If the directive says "translate", we coerce to
      // "regenerate" — the walker leaves the field unset so a lifecycle
      // (e.g. slugify) can derive a fresh slug from the translated title.
      if (type === "uid") {
        const dir = directive === "translate" ? "regenerate" : directive;
        out.push({ name, type, directive: dir, format: "plain" });
        continue;
      }
      out.push({
        name,
        type,
        directive: isTranslatable ? directive : "copy",
        format: formatFor(type),
      });
      continue;
    }

    // unknown type — copy by default
    out.push({ name, type, directive: "copy" });
  }
  return out;
};

module.exports = ({ strapi }) => ({
  /**
   * Return the field map for a content type or component UID.
   * Includes the strapi schema reference for downstream lookups.
   */
  describe(uid) {
    const schema = strapi.getModel(uid);
    if (!schema) {
      throw new Error(`[translate] unknown model: ${uid}`);
    }
    return {
      uid,
      kind: schema.kind, // 'collectionType' | 'singleType' | 'component'
      attributes: describeAttributes(schema),
    };
  },

  /**
   * Build a deep populate spec for the document service. Walks components and
   * dynamic zones recursively so we get the full source tree to translate.
   */
  buildPopulate(uid, depth = 0, maxDepth = 6) {
    if (depth > maxDepth) return true;
    const schema = strapi.getModel(uid);
    if (!schema) return true;

    const populate = {};
    for (const [name, attr] of Object.entries(schema.attributes)) {
      if (attr.writable === false) continue;
      if (attr.type === "component") {
        populate[name] = {
          populate: this.buildPopulate(attr.component, depth + 1, maxDepth),
        };
      } else if (attr.type === "dynamiczone") {
        // `populate: "*"` only walks one level into each DZ item, so media or
        // components nested inside a DZ component (e.g. slides[].image inside
        // page.slider) come back unpopulated. Mirror Strapi v5's own
        // getDeepPopulate by using the `on:` fragment syntax with a per-
        // component populate spec.
        const components = attr.components || [];
        if (components.length > 0) {
          const on = {};
          for (const componentUid of components) {
            on[componentUid] = {
              populate: this.buildPopulate(componentUid, depth + 1, maxDepth),
            };
          }
          populate[name] = { on };
        } else {
          populate[name] = { populate: "*" };
        }
      } else if (attr.type === "media") {
        populate[name] = true;
      } else if (attr.type === "relation") {
        // We don't deep-populate relations — we only need the documentId/id
        // to potentially re-link to a target-locale entry, not the full body.
        populate[name] = true;
      }
    }
    return populate;
  },
});
