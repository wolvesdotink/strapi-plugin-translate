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
      for (const key of c.items) {
        const node = source.nodes[key];
        if (!target.nodes[mapping[key]]) delete mapping[key];
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
            unresolved.push({
              sourceKey: key,
              label: node.label,
              sourcePath: node.path.join("."),
              candidates: candidates.map((k) => ({
                key: k,
                path: target.nodes[k].path.join("."),
                label: target.nodes[k].label,
              })),
            });
        }
        if (mapping[key]) walk(key);
      }
    }
  };
  walk("root");
  const used = Object.values(mapping);
  if (new Set(used).size !== used.length)
    throw problem("Two source modules cannot use the same target module.", 400);
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
