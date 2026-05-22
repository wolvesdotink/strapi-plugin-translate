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

// Structured diff for a tag/URL multiset mismatch. Returns null when shapes
// match. The `summary` field is short and LLM-friendly — we feed it back to
// the model on retry so it knows exactly which tags it dropped or added.
const describeHtmlMismatch = (input, output) => {
  let a, b;
  try {
    a = extractHtmlSignature(input);
    b = extractHtmlSignature(output);
  } catch (err) {
    return {
      summary: `parse error: ${err.message}`,
      missingTags: {},
      extraTags: {},
      missingUrls: [],
      extraUrls: [],
    };
  }

  const countBy = (arr) => {
    const m = Object.create(null);
    for (const x of arr) m[x] = (m[x] || 0) + 1;
    return m;
  };
  const aTags = countBy(a.tags);
  const bTags = countBy(b.tags);
  const missingTags = {};
  const extraTags = {};
  const tagNames = new Set([...Object.keys(aTags), ...Object.keys(bTags)]);
  for (const tag of tagNames) {
    const diff = (aTags[tag] || 0) - (bTags[tag] || 0);
    if (diff > 0) missingTags[tag] = diff;
    else if (diff < 0) extraTags[tag] = -diff;
  }

  const aUrls = countBy(a.urls);
  const bUrls = countBy(b.urls);
  const missingUrls = [];
  const extraUrls = [];
  const urlSet = new Set([...Object.keys(aUrls), ...Object.keys(bUrls)]);
  for (const u of urlSet) {
    const diff = (aUrls[u] || 0) - (bUrls[u] || 0);
    for (let i = 0; i < diff; i++) missingUrls.push(u);
    for (let i = 0; i < -diff; i++) extraUrls.push(u);
  }

  if (
    Object.keys(missingTags).length === 0 &&
    Object.keys(extraTags).length === 0 &&
    missingUrls.length === 0 &&
    extraUrls.length === 0
  ) {
    return null;
  }

  const parts = [];
  for (const [tag, n] of Object.entries(missingTags)) {
    parts.push(`missing ${n} <${tag.toLowerCase()}> tag(s)`);
  }
  for (const [tag, n] of Object.entries(extraTags)) {
    parts.push(`extra ${n} <${tag.toLowerCase()}> tag(s)`);
  }
  for (const u of missingUrls) parts.push(`missing URL "${u}"`);
  for (const u of extraUrls) parts.push(`extra URL "${u}"`);

  return {
    summary: parts.join("; "),
    missingTags,
    extraTags,
    missingUrls,
    extraUrls,
  };
};

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
  describeHtmlMismatch,
  collectBlocksTexts,
  applyBlocksTexts,
});
