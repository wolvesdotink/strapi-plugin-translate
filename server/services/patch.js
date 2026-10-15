import {
  clone,
  get,
  set,
  writable,
  initialPayload,
  problem,
  fingerprint,
} from "./content-tree";

export function selectedPaths(prepared) {
  if (prepared.initialTranslation) return undefined;
  const paths = new Set();
  for (const op of prepared.ops) {
    if (op.kind === "field") paths.add(op.path.join("."));
    else
      for (const item of op.items.filter((k) => !op.beforeItems.includes(k))) {
        for (const f of Object.values(prepared.current.fields))
          if (f.nodeKey === item || f.nodeKey.startsWith(`${item}/`))
            paths.add(f.path.join("."));
      }
  }
  return [...paths];
}

export function mergePatch(strapi, prepared, computed, ops = prepared.ops) {
  if (prepared.initialTranslation) {
    prepared.appliedPaths = Object.fromEntries(
      Object.values(prepared.current.nodes).map((n) => [n.key, n.path]),
    );
    return initialPayload(strapi, prepared.uid, computed);
  }
  const data = writable(strapi, prepared.uid, prepared.target);
  const appliedPaths = {};
  const structureItems = {};
  for (const [key, targetKey] of Object.entries(prepared.mapping)) {
    if (prepared.targetTree.nodes[targetKey])
      appliedPaths[key] = prepared.targetTree.nodes[targetKey].path;
  }
  // Field edits precede array moves; both paths are resolved by identity.
  for (const op of ops.filter((op) => op.kind === "field")) {
    const path = appliedPaths[op.nodeKey];
    if (!path)
      throw problem(
        `The target module for ${op.path.join(".")} is missing. Align the modules or run a full translation.`,
      );
    set(
      data,
      path.concat(op.name),
      op.directive === "delete" ? null : (get(computed, op.path) ?? op.value),
    );
  }
  for (const op of ops
    .filter((op) => op.kind === "structure")
    .sort((a, b) => b.path.length - a.path.length)) {
    const parentPath = appliedPaths[op.nodeKey];
    if (!parentPath)
      throw problem(
        `The target container ${op.path.join(".")} cannot be aligned.`,
      );
    const targetPath = parentPath.concat(op.name);
    const beforeTargets = op.beforeItems
      .map((key) => prepared.mapping[key])
      .filter(Boolean);
    const original = op.many
      ? get(data, targetPath) || []
      : get(data, targetPath)
        ? [get(data, targetPath)]
        : [];
    const targetContainer =
      prepared.targetTree.containers[
        `${prepared.mapping[op.nodeKey]}/${op.name}`
      ];
    const targetItems = targetContainer?.items || [];
    const byKey = new Map(targetItems.map((k, i) => [k, original[i]]));
    const desired = [];
    for (const key of op.items) {
      const targetKey = prepared.mapping[key];
      if (op.beforeItems.includes(key)) {
        if (!targetKey || !byKey.has(targetKey))
          throw problem(
            "A target module was removed. Review module alignment before applying.",
          );
        desired.push({ sourceKey: key, value: byKey.get(targetKey) });
      } else {
        const node = prepared.current.nodes[key];
        desired.push({
          sourceKey: key,
          value: clone(get(computed, node.path)),
        });
      }
    }
    // Keep independently added target modules in their existing slots. Replace
    // only the mapped source sequence; append remaining new source modules.
    const result = [],
      identities = [],
      kept = [];
    let cursor = 0;
    for (let i = 0; i < original.length; i++) {
      if (beforeTargets.includes(targetItems[i])) {
        if (cursor < desired.length) {
          result.push(desired[cursor].value);
          identities.push(desired[cursor++].sourceKey);
        }
      } else {
        result.push(original[i]);
        identities.push(null);
        kept[result.length - 1] = targetItems[i];
      }
    }
    while (cursor < desired.length) {
      result.push(desired[cursor].value);
      identities.push(desired[cursor++].sourceKey);
    }
    set(data, targetPath, op.many ? result : result[0] || null);
    // The resulting order, including target-only modules kept in place.
    structureItems[op.id] = identities.map((key, index) =>
      key ? { source: key } : { target: kept[index] },
    );
    identities.forEach((key, index) => {
      if (!key) return;
      const sourcePath = prepared.current.nodes[key].path;
      const oldPath = appliedPaths[key];
      const newPath = op.many ? targetPath.concat(index) : targetPath;
      for (const node of Object.values(prepared.current.nodes)) {
        if (node.key === key || node.key.startsWith(`${key}/`)) {
          // Existing descendants can have an independently edited target
          // order. Moving their ancestor only replaces the ancestor prefix.
          const relativePath =
            oldPath && appliedPaths[node.key]
              ? appliedPaths[node.key].slice(oldPath.length)
              : node.path.slice(sourcePath.length);
          appliedPaths[node.key] = newPath.concat(relativePath);
        }
      }
    });
    for (const key of op.beforeItems.filter((k) => !op.items.includes(k))) {
      for (const k of Object.keys(appliedPaths))
        if (k === key || k.startsWith(`${key}/`)) delete appliedPaths[k];
    }
  }
  prepared.appliedPaths = appliedPaths;
  prepared.structureItems = structureItems;
  // Omit untouched top-level fields from the update. A changed dynamic-zone
  // array still contains its current untouched TARGET children and IDs.
  const roots = new Set(
    ops.map((op) => prepared.appliedPaths[op.nodeKey]?.[0] || op.name),
  );
  return Object.fromEntries([...roots].map((root) => [root, data[root]]));
}

// "Hero · Welcome to the mountains": same-type modules in an order change are
// only distinguishable by what they say. Only text `allowed` may show.
const firstText = (tree, key, allowed) =>
  Object.values(tree?.fields || {}).find(
    (f) =>
      f.nodeKey === key &&
      ["string", "text"].includes(f.type) &&
      typeof f.value === "string" &&
      f.value.trim() &&
      allowed(tree, f),
  );
const itemLabel = (label, text) => {
  const short =
    typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!short) return label;
  return `${label} · ${short.length > 60 ? `${short.slice(0, 59)}…` : short}`;
};

export function previewModules(
  prepared,
  proposed,
  ops,
  { textAllowed = () => false } = {},
) {
  const sourceText = (tree, f) => textAllowed(tree, f, "source");
  const targetText = (tree, f) => textAllowed(tree, f, "target");
  const structureItems = (op) => ({
    source: op.items.map((k) =>
      itemLabel(
        prepared.current.nodes[k].label,
        firstText(prepared.current, k, sourceText)?.value,
      ),
    ),
    // What the translation holds today, in its own order.
    before: (
      prepared.targetTree?.containers[
        `${prepared.mapping[op.nodeKey]}/${op.name}`
      ]?.items || []
    ).map((k) =>
      itemLabel(
        prepared.targetTree.nodes[k]?.label,
        firstText(prepared.targetTree, k, targetText)?.value,
      ),
    ),
    after: (
      prepared.structureItems?.[op.id] || op.items.map((k) => ({ source: k }))
    ).map(({ source: k, target }) => {
      if (!k)
        return itemLabel(
          prepared.targetTree.nodes[target]?.label,
          firstText(prepared.targetTree, target, targetText)?.value,
        );
      const field = firstText(prepared.current, k, sourceText);
      const path = prepared.appliedPaths?.[k];
      // A module the translation already has may keep its own text there.
      const targetKey = prepared.mapping[k];
      const targetField =
        field && targetKey
          ? prepared.targetTree?.fields[`${targetKey}/${field.name}`]
          : null;
      const readable =
        field &&
        path &&
        (!targetKey ||
          (targetField && targetText(prepared.targetTree, targetField)));
      return itemLabel(
        prepared.current.nodes[k].label,
        readable ? get(proposed, path.concat(field.name)) : null,
      );
    }),
  });
  const groups = new Map();
  for (const op of ops) {
    const key = op.moduleKey;
    const node =
      prepared.current.nodes[key] || prepared.current.nodes[op.nodeKey];
    const targetPath = prepared.appliedPaths?.[node.key] || [];
    if (!groups.has(key))
      groups.set(key, {
        key,
        label: node.label || op.name,
        sourcePath: node.path.join("."),
        fields: [],
      });
    groups.get(key).fields.push({
      id: op.id,
      kind: op.kind,
      name: op.name,
      type: op.type,
      ...(op.kind === "field"
        ? {
            source: op.value,
            before:
              prepared.targetTree?.fields[
                `${prepared.mapping[op.nodeKey]}/${op.name}`
              ]?.value,
            after: get(
              proposed,
              (prepared.appliedPaths?.[op.nodeKey] || targetPath).concat(
                op.name,
              ),
            ),
          }
        : structureItems(op)),
    });
  }
  // Insertion is one structural operation, but every generated field must
  // still be visible before the editor approves creating the module.
  for (const op of ops.filter((op) => op.kind === "structure")) {
    for (const item of op.items.filter((k) => !op.beforeItems.includes(k))) {
      for (const field of Object.values(prepared.current.fields).filter(
        (f) => f.nodeKey === item || f.nodeKey.startsWith(`${item}/`),
      )) {
        const key = field.moduleKey;
        const node =
          prepared.current.nodes[key] || prepared.current.nodes[field.nodeKey];
        if (!groups.has(key))
          groups.set(key, {
            key,
            label: node.label,
            sourcePath: node.path.join("."),
            fields: [],
          });
        groups.get(key).fields.push({
          id: field.key,
          operationId: op.id,
          kind: "inserted-field",
          name: field.name,
          type: field.type,
          source: field.value,
          before: null,
          after: get(
            proposed,
            prepared.appliedPaths[field.nodeKey].concat(field.name),
          ),
        });
      }
    }
  }
  return [...groups.values()];
}

export const targetFingerprint = (strapi, uid, target) =>
  fingerprint(target ? writable(strapi, uid, target) : null);
