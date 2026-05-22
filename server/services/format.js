"use strict";

// Format helpers. The CKEditor fields in this project store HTML strings;
// we keep them as a single string per field and instruct the LLM to preserve
// tags exactly. Blocks (Strapi native rich text) is handled by walking the
// JSON tree and translating only `text` properties of nodes.

const { parse } = require("node-html-parser");

// --------- HTML ---------

const isWhitespaceOnly = (s) => !s || /^\s*$/.test(s);

// Pull tag-name multiset and URL-bearing attribute multiset out of an HTML
// string. We use these to validate that translator output preserves structure.
const extractHtmlSignature = (html) => {
  const tree = parse(html || "");
  const tags = tree
    .querySelectorAll("*")
    .map((el) => el.tagName)
    .filter(Boolean)
    .sort();
  const urls = [];
  for (const el of tree.querySelectorAll("a[href], img[src], source[src], video[src], audio[src]")) {
    const href = el.getAttribute("href");
    const src = el.getAttribute("src");
    if (href) urls.push(href);
    if (src) urls.push(src);
  }
  urls.sort();
  return { tags, urls };
};

// Validate that translator output preserves the HTML structure of the input.
// Compares tag-name multisets exactly (no ±1 tolerance — we have a parser,
// use it) and URL-bearing attribute multisets (so the translator can't silently
// rewrite links). Returns { ok: bool, reason?: string }.
const validateHtmlShape = (input, output) => {
  try {
    const a = extractHtmlSignature(input);
    const b = extractHtmlSignature(output);
    if (a.tags.length !== b.tags.length || a.tags.join(",") !== b.tags.join(",")) {
      return {
        ok: false,
        reason: `tag-name multiset mismatch: [${a.tags.join("|")}] vs [${b.tags.join("|")}]`,
      };
    }
    if (a.urls.length !== b.urls.length || a.urls.join(",") !== b.urls.join(",")) {
      return {
        ok: false,
        reason: `URL attribute mismatch: [${a.urls.join("|")}] vs [${b.urls.join("|")}]`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
};

// Backwards-compat alias for callers that haven't migrated yet.
const compareHtmlStructure = validateHtmlShape;

// --------- Strapi Blocks (native rich-text JSON) ---------
//
// Blocks is an array of nodes; each node may have `children` and may have a
// `text` string at the leaf. We collect leaf text + paths so we can
// reconstruct after translation.
//
// Path is encoded as a series of indices, e.g. "0.children.2.children.0".

const collectBlocksTexts = (blocks) => {
  const items = []; // { path, text }
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, path.concat(i)));
      return;
    }
    if (node && typeof node === "object") {
      if (typeof node.text === "string" && !isWhitespaceOnly(node.text)) {
        items.push({ path: path.concat("text"), text: node.text });
      }
      if (Array.isArray(node.children)) {
        node.children.forEach((c, i) =>
          walk(c, path.concat("children", i))
        );
      }
    }
  };
  walk(blocks, []);
  return items;
};

const applyBlocksTexts = (blocks, items, translations) => {
  // Deep clone so we don't mutate the source
  const clone = JSON.parse(JSON.stringify(blocks));
  items.forEach((item, i) => {
    let cursor = clone;
    for (let p = 0; p < item.path.length - 1; p++) {
      cursor = cursor[item.path[p]];
    }
    cursor[item.path[item.path.length - 1]] = translations[i];
  });
  return clone;
};

module.exports = () => ({
  isWhitespaceOnly,
  compareHtmlStructure,
  validateHtmlShape,
  extractHtmlSignature,
  collectBlocksTexts,
  applyBlocksTexts,
});
