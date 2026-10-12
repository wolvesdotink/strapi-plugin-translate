import { set, clone } from "./content-tree";

export default ({ strapi }) => ({
  async resolve(
    prepared,
    data,
    {
      selectedModules = undefined,
      selectedFields = undefined,
      operations = prepared.ops,
      before = false,
    } = {},
  ) {
    const tree = prepared.current;
    const affected = new Set(
      selectedModules || operations.map((op) => op.moduleKey),
    );
    const inserted = operations
      .filter((op) => op.kind === "structure")
      .flatMap((op) => op.items.filter((k) => !op.beforeItems.includes(k)));
    const isInserted = (f) =>
      inserted.some(
        (key) => f.nodeKey === key || f.nodeKey.startsWith(`${key}/`),
      );
    const refs = Object.values(tree.fields).filter(
      (f) =>
        f.type === "relation" &&
        (prepared.initialTranslation ||
          affected.has(f.moduleKey) ||
          isInserted(f)) &&
        (!selectedFields || selectedFields.has(f.key) || isInserted(f)) &&
        f.directive !== "skip" &&
        f.directive !== "delete",
    );
    const decisions = [],
      groups = new Map();
    for (const f of refs) {
      const schema = strapi.getModel(f.target);
      if (!schema?.pluginOptions?.i18n?.localized) continue;
      if (!groups.has(f.target)) groups.set(f.target, new Set());
      for (const id of Array.isArray(f.value)
        ? f.value
        : f.value
          ? [f.value]
          : [])
        groups.get(f.target).add(id);
    }
    const available = new Map();
    for (const [uid, ids] of groups) {
      const rows = ids.size
        ? await strapi.documents(uid).findMany({
            locale: prepared.targetLocale,
            status: "draft",
            filters: { documentId: { $in: [...ids] } },
          })
        : [];
      const published =
        strapi.getModel(uid).options?.draftAndPublish && ids.size
          ? await strapi.documents(uid).findMany({
              locale: prepared.targetLocale,
              status: "published",
              filters: { documentId: { $in: [...ids] } },
              fields: ["documentId"],
            })
          : rows;
      // Items without a target-language version are labelled from the
      // source language rather than shown as bare document IDs.
      const missing = [...ids].filter(
        (id) => !rows.some((r) => r.documentId === id),
      );
      const sourceRows = missing.length
        ? await strapi.documents(uid).findMany({
            locale: prepared.sourceLocale,
            status: "draft",
            filters: { documentId: { $in: missing } },
          })
        : [];
      available.set(uid, {
        rows: new Map(rows.map((r) => [r.documentId, r])),
        sourceRows: new Map(sourceRows.map((r) => [r.documentId, r])),
        published: new Set(published.map((r) => r.documentId)),
      });
    }
    for (const f of refs) {
      if (!available.has(f.target)) continue;
      const sourceIds = Array.isArray(f.value)
        ? f.value
        : f.value
          ? [f.value]
          : [];
      const path = before
        ? f.path
        : prepared.appliedPaths[f.nodeKey]?.concat(f.name);
      if (!path) continue;
      const ids = [];
      for (const id of sourceIds) {
        const { rows, sourceRows, published } = available.get(f.target);
        const entry = rows.get(id);
        const fallback = sourceRows.get(id);
        const decision = {
          path: path.join("."),
          fieldKey: f.key,
          moduleKey: f.moduleKey,
          uid: f.target,
          documentId: id,
          targetLocale: prepared.targetLocale,
          label:
            entry?.title ||
            entry?.name ||
            fallback?.title ||
            fallback?.name ||
            id,
          status: entry
            ? published.has(id)
              ? "available"
              : "draft-only"
            : "missing",
          required: !!strapi.getModel(tree.nodes[f.nodeKey].uid).attributes[
            f.name
          ].required,
        };
        decisions.push(decision);
        if (entry) ids.push(id);
      }
      // Availability is validated BEFORE provider calls, and again on apply.
      // Missing links stay unresolved until the editor selects a child
      // translation or explicitly allows optional omission.
      if (data && !before)
        set(data, path, Array.isArray(f.value) ? { set: ids } : ids[0] || null);
    }
    return clone(decisions);
  },
});
