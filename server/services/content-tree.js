import crypto from "node:crypto";

export const clone = (value) =>
  value == null ? value : JSON.parse(JSON.stringify(value));
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const fingerprint = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "undefined")
    .digest("hex");
export const get = (value, path) => path.reduce((v, key) => v?.[key], value);
export const set = (value, path, next) => {
  let cursor = value;
  for (const key of path.slice(0, -1)) cursor = cursor[key];
  cursor[path.at(-1)] = clone(next);
};
export const problem = (message, status = 409) =>
  Object.assign(new Error(message), { status });

// Schema-aware snapshots retain identities separately from values. Field keys
// follow source component identity, not array positions or target-locale IDs.
export function snapshot(strapi, uid, entry) {
  const fields = {},
    nodes = {},
    containers = {};
  const walk = (model, value, key, path, moduleKey, root = false) => {
    const schema = strapi.getModel(model);
    nodes[key] = {
      key,
      uid: model,
      id: value?.id,
      path,
      moduleKey,
      label: schema.info?.displayName || model,
      stableKey: value?.translationKey || null,
    };
    const descriptors = strapi
      .plugin("translate")
      .service("translatable-fields")
      .describe(model).attributes;
    for (const attr of descriptors) {
      const raw = schema.attributes[attr.name];
      if (
        root &&
        schema.pluginOptions?.i18n?.localized &&
        raw.pluginOptions?.i18n?.localized !== true
      )
        continue;
      if (["skip", "regenerate"].includes(attr.directive)) continue;
      const nextPath = path.concat(attr.name),
        fieldKey = `${key}/${attr.name}`;
      const v = value?.[attr.name];
      if (attr.type === "component" || attr.type === "dynamiczone") {
        if (attr.directive !== "translate") {
          fields[fieldKey] = {
            key: fieldKey,
            nodeKey: key,
            name: attr.name,
            path: nextPath,
            moduleKey: moduleKey || fieldKey,
            directive: attr.directive,
            type: attr.type,
            value: clone(v ?? null),
          };
          continue;
        }
        const many = attr.type === "dynamiczone" || attr.repeatable;
        const values = many ? v || [] : v ? [v] : [];
        const items = [];
        values.forEach((item, index) => {
          const childUid =
            attr.type === "dynamiczone" ? item.__component : attr.component;
          const identity = item.translationKey || item.id;
          if (identity == null)
            throw problem(
              `Missing component identity at ${nextPath.join(".")}. Save the source first.`,
            );
          const childKey = `${fieldKey}:${childUid}:${identity}`;
          items.push(childKey);
          walk(
            childUid,
            item,
            childKey,
            many ? nextPath.concat(index) : nextPath,
            moduleKey || childKey,
          );
        });
        if (new Set(items).size !== items.length)
          throw problem(`Duplicate module identity at ${nextPath.join(".")}.`);
        containers[fieldKey] = {
          key: fieldKey,
          nodeKey: key,
          name: attr.name,
          path: nextPath,
          many,
          type: attr.type,
          items,
          moduleKey: moduleKey || fieldKey,
        };
      } else {
        const normalized =
          attr.type === "relation"
            ? Array.isArray(v)
              ? v.map((r) => r.documentId || r.id)
              : v?.documentId || v?.id || null
            : attr.type === "media"
              ? Array.isArray(v)
                ? v.map((r) => r.id)
                : v?.id || null
              : clone(v ?? null);
        fields[fieldKey] = {
          key: fieldKey,
          nodeKey: key,
          name: attr.name,
          path: nextPath,
          moduleKey: moduleKey || fieldKey,
          directive: attr.directive,
          type: attr.type,
          value: normalized,
          target: attr.target,
        };
      }
    }
  };
  walk(uid, entry, "root", [], null, true);
  return { fields, nodes, containers };
}

export function operations(before, after) {
  const out = [];
  for (const [key, field] of Object.entries(after.fields)) {
    if (!before.nodes[field.nodeKey]) continue; // insertion carries the subtree
    if (fingerprint(before.fields[key]?.value) !== fingerprint(field.value))
      out.push({ id: key, kind: "field", ...field });
  }
  for (const [key, container] of Object.entries({
    ...before.containers,
    ...after.containers,
  })) {
    if (!after.nodes[container.nodeKey] || !before.nodes[container.nodeKey])
      continue;
    const a = before.containers[key]?.items || [],
      b = after.containers[key]?.items || [];
    if (fingerprint(a) !== fingerprint(b))
      out.push({
        id: key,
        kind: "structure",
        ...container,
        items: b,
        beforeItems: a,
      });
  }
  return out;
}

// Existing translations can be aligned unambiguously by a stable application
// key or a single instance of a component type. Duplicates require editor input.
export function align(source, target, previous = {}, explicit = {}) {
  const mapping = {
    root: "root",
    ...Object.fromEntries(
      Object.entries(previous).filter(
        ([sourceKey, targetKey]) =>
          source.nodes[sourceKey] && target.nodes[targetKey],
      ),
    ),
  };
  const unresolved = [];
  const walk = (sourceNodeKey) => {
    for (const c of Object.values(source.containers).filter(
      (c) => c.nodeKey === sourceNodeKey,
    )) {
      const parentTarget = mapping[sourceNodeKey];
      const tc = target.containers[`${parentTarget}/${c.name}`];
      if (!tc) continue;
      const rows = [];
      for (const key of c.items) {
        const node = source.nodes[key];
        if (!target.nodes[mapping[key]]) delete mapping[key];
        // An editor can confirm a removed module no longer exists there.
        if (key in explicit && explicit[key] == null) {
          delete mapping[key];
          continue;
        }
        if (explicit[key]) {
          if (
            !tc.items.includes(explicit[key]) ||
            target.nodes[explicit[key]]?.uid !== node.uid
          )
            throw problem("Invalid module alignment.", 400);
          mapping[key] = explicit[key];
        }
        if (!mapping[key]) {
          const candidates = tc.items.filter(
            (k) => target.nodes[k].uid === node.uid,
          );
          const stable =
            node.stableKey &&
            candidates.find(
              (k) => target.nodes[k].stableKey === node.stableKey,
            );
          const sameTypeSource = c.items.filter(
            (k) => source.nodes[k].uid === node.uid,
          );
          if (
            stable ||
            (candidates.length === 1 && sameTypeSource.length === 1)
          )
            mapping[key] = stable || candidates[0];
          else if (candidates.length)
            rows.push({
              sourceKey: key,
              label: node.label,
              sourcePath: node.path.join("."),
              position: c.items.indexOf(key) + 1,
              candidates: candidates.map((k) => ({
                key: k,
                path: target.nodes[k].path.join("."),
                label: target.nodes[k].label,
                position: tc.items.indexOf(k) + 1,
              })),
            });
        }
        if (mapping[key]) walk(key);
      }
      suggest(rows, c, tc);
      unresolved.push(...rows);
    }
  };
  // Pre-select the likeliest pair for each ambiguous module so the editor
  // confirms instead of searching: values that stay identical across
  // languages (media, links, numbers) first, then the order on the page.
  const suggest = (rows, c, tc) => {
    const mapped = new Set(Object.values(mapping));
    const taken = new Set(mapped);
    const open = (items, tree, isOpen) => (k) =>
      items.filter((i) => tree.nodes[i].uid === tree.nodes[k].uid && isOpen(i));
    const sourceOpen = open(c.items, source, (k) => !mapping[k]);
    const targetOpen = open(tc.items, target, (k) => !mapped.has(k));
    const shared = (sourceKey, targetKey) =>
      Object.values(source.fields).filter((f) => {
        if (
          f.nodeKey !== sourceKey ||
          f.value == null ||
          f.value === "" ||
          (Array.isArray(f.value) && !f.value.length)
        )
          return false;
        const other = target.fields[`${targetKey}/${f.name}`];
        return other && fingerprint(other.value) === fingerprint(f.value);
      }).length;
    for (const row of rows) {
      const order = sourceOpen(row.sourceKey).indexOf(row.sourceKey);
      let best = null;
      for (const candidate of row.candidates) {
        if (taken.has(candidate.key)) continue;
        const distance = Math.abs(
          targetOpen(candidate.key).indexOf(candidate.key) - order,
        );
        const score = shared(row.sourceKey, candidate.key) * 100 - distance;
        if (!best || score > best.score) best = { key: candidate.key, score };
      }
      row.suggested = best?.key || null;
      if (best) taken.add(best.key);
    }
  };
  walk("root");
  const used = Object.values(mapping);
  if (new Set(used).size !== used.length)
    throw problem("Two source modules cannot use the same target module.", 400);
  // Targets already paired automatically can't be picked a second time.
  for (const row of unresolved)
    row.candidates = row.candidates.filter((c) => !used.includes(c.key));
  return { mapping, unresolved };
}

// Convert a populated target tree to a writable tree without leaking managed
// fields or populated relation bodies. Preserve TARGET component IDs.
export function writable(strapi, uid, entry, keepIds = true) {
  return writeTree(strapi, uid, entry, { keepIds, populated: true });
}

// Computed translations already contain writable relation/media commands.
// Remove source identities and audit fields without interpreting those
// commands as populated entities or stripping keys inside arbitrary JSON.
export function initialPayload(strapi, uid, entry) {
  return writeTree(strapi, uid, entry, { keepIds: false, populated: false });
}

function writeTree(strapi, uid, entry, options) {
  const { keepIds, populated } = options;
  if (!entry) return null;
  const schema = strapi.getModel(uid),
    out = {};
  if (keepIds && entry.id != null && schema.modelType === "component")
    out.id = entry.id;
  if (entry.__component) out.__component = entry.__component;
  for (const [name, attr] of Object.entries(schema.attributes || {})) {
    if (
      attr.writable === false ||
      [
        "id",
        "documentId",
        "locale",
        "createdAt",
        "updatedAt",
        "publishedAt",
        "createdBy",
        "updatedBy",
        "localizations",
      ].includes(name)
    )
      continue;
    const v = entry[name];
    if (v === undefined) continue;
    if (attr.type === "component")
      out[name] = attr.repeatable
        ? (v || []).map((x) => writeTree(strapi, attr.component, x, options))
        : writeTree(strapi, attr.component, v, options);
    else if (attr.type === "dynamiczone")
      out[name] = (v || []).map((x) =>
        writeTree(strapi, x.__component, x, options),
      );
    else if (!populated && ["relation", "media"].includes(attr.type))
      out[name] = clone(v);
    else if (attr.type === "relation")
      out[name] = Array.isArray(v)
        ? v.map((x) => x.documentId || x.id)
        : v?.documentId || v?.id || null;
    else if (attr.type === "media")
      out[name] = Array.isArray(v) ? v.map((x) => x.id) : v?.id || null;
    else out[name] = clone(v);
  }
  return out;
}

const TEXT_TYPES = ["string", "text", "richtext", "email"];
const plain = (value, max = 220) => {
  const text = String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const blockText = (node) =>
  Array.isArray(node)
    ? node.map(blockText).join(" ")
    : node && typeof node === "object"
      ? [node.text, blockText(node.children)].filter(Boolean).join(" ")
      : "";

// Strapi treats an attribute as private when its schema says so, or when the
// model or the API response config lists it.
export const privateAttribute = (strapi, uid, name) => {
  const model = strapi.getModel(uid);
  return !!(
    model?.attributes?.[name]?.private ||
    model?.options?.privateAttributes?.includes(name) ||
    strapi.config?.get?.("api.responses.privateAttributes", [])?.includes(name)
  );
};

// A readable digest of one module so editors can recognise it: its texts,
// images and linked items. Not used for matching or writing. Pass a
// permission-sanitized entry; `canRead` decides which linked types to name.
export function summarize(strapi, uid, value, { canRead = () => true } = {}) {
  const texts = [],
    media = [],
    links = [];
  const walk = (model, entry, prefix, depth) => {
    const schema = strapi.getModel(model);
    if (!schema || !entry || depth > 3) return;
    for (const [name, attr] of Object.entries(schema.attributes || {})) {
      const v = entry[name];
      if (
        v == null ||
        attr.writable === false ||
        privateAttribute(strapi, model, name)
      )
        continue;
      const label = prefix.concat(name);
      if (TEXT_TYPES.includes(attr.type) || attr.type === "blocks") {
        const text = plain(attr.type === "blocks" ? blockText(v) : v);
        if (text) texts.push({ name: label, text });
      } else if (attr.type === "media")
        for (const file of Array.isArray(v) ? v : [v])
          media.push({
            name: file.alternativeText || file.name || null,
            url: file.mime?.startsWith("image/")
              ? file.formats?.thumbnail?.url || file.url
              : null,
          });
      else if (attr.type === "relation" && canRead(attr.target)) {
        const related = strapi.getModel(attr.target)?.attributes || {};
        const field = ["title", "name", "label"].find(
          (key) => related[key] && !privateAttribute(strapi, attr.target, key),
        );
        for (const item of Array.isArray(v) ? v : [v])
          if (field && item?.[field]) links.push(plain(item[field], 80));
      } else if (attr.type === "component")
        for (const item of Array.isArray(v) ? v : [v])
          walk(attr.component, item, label, depth + 1);
      else if (attr.type === "dynamiczone")
        for (const item of v) walk(item.__component, item, label, depth + 1);
    }
  };
  walk(uid, value, [], 0);
  return { texts, media, links: links.filter(Boolean) };
}

// A module nested anywhere inside a private component or dynamic zone.
export function hiddenNode(strapi, tree, nodeKey) {
  for (let key = nodeKey; key && key !== "root"; ) {
    const container = Object.values(tree.containers).find((c) =>
      c.items.includes(key),
    );
    if (!container) break;
    if (
      privateAttribute(
        strapi,
        tree.nodes[container.nodeKey]?.uid,
        container.name,
      )
    )
      return true;
    key = container.nodeKey;
  }
  return false;
}

// Private attributes never leave the server, including anything nested in a
// private component or dynamic zone.
export const isPrivate = (strapi, tree, field) =>
  privateAttribute(strapi, tree.nodes[field.nodeKey]?.uid, field.name) ||
  hiddenNode(strapi, tree, field.nodeKey);

// Texts of a module that only exists in an older snapshot, e.g. one removed
// from the source since the last translation. `allow` checks field access.
export function summarizeSnapshot(strapi, tree, key, allow = () => true) {
  const texts = Object.values(tree.fields)
    .filter(
      (f) =>
        (f.nodeKey === key || f.nodeKey.startsWith(`${key}/`)) &&
        !isPrivate(strapi, tree, f) &&
        allow(f) &&
        (TEXT_TYPES.includes(f.type) || f.type === "blocks") &&
        f.value != null,
    )
    .map((f) => ({
      name: [f.name],
      text: plain(f.type === "blocks" ? blockText(f.value) : f.value),
    }))
    .filter((f) => f.text);
  return { texts, media: [], links: [] };
}
