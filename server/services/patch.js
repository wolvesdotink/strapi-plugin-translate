import {
  clone,
  get,
  set,
  writable,
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
    return clone(computed);
  }
  const data = writable(strapi, prepared.uid, prepared.target);
  const appliedPaths = {};
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
      identities = [];
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
      }
    }
    while (cursor < desired.length) {
      result.push(desired[cursor].value);
      identities.push(desired[cursor++].sourceKey);
    }
    set(data, targetPath, op.many ? result : result[0] || null);
    identities.forEach((key, index) => {
      if (!key) return;
      const sourcePath = prepared.current.nodes[key].path;
      const newPath = op.many ? targetPath.concat(index) : targetPath;
      for (const node of Object.values(prepared.current.nodes)) {
        if (node.key === key || node.key.startsWith(`${key}/`))
          appliedPaths[node.key] = newPath.concat(
            node.path.slice(sourcePath.length),
          );
      }
    });
    for (const key of op.beforeItems.filter((k) => !op.items.includes(k))) {
      for (const k of Object.keys(appliedPaths))
        if (k === key || k.startsWith(`${key}/`)) delete appliedPaths[k];
    }
  }
  prepared.appliedPaths = appliedPaths;
  // Omit untouched top-level fields from the update. A changed dynamic-zone
  // array still contains its current untouched TARGET children and IDs.
  const roots = new Set(
    ops.map((op) => prepared.appliedPaths[op.nodeKey]?.[0] || op.name),
  );
  return Object.fromEntries([...roots].map((root) => [root, data[root]]));
}

export function previewModules(prepared, proposed, ops) {
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
      source:
        op.kind === "field"
          ? op.value
          : op.items.map((k) => prepared.current.nodes[k].label),
      before:
        op.kind === "field"
          ? prepared.targetTree?.fields[
              `${prepared.mapping[op.nodeKey]}/${op.name}`
            ]?.value
          : op.beforeItems.map((k) => prepared.before.nodes[k]?.label),
      after:
        op.kind === "field"
          ? get(
              proposed,
              (prepared.appliedPaths?.[op.nodeKey] || targetPath).concat(
                op.name,
              ),
            )
          : op.items.map((k) => prepared.current.nodes[k].label),
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
