import {
  snapshot,
  operations,
  fingerprint,
  align,
  clone,
  problem,
} from "./content-tree";

export default ({ strapi }) => {
  const state = () => strapi.plugin("translate").service("state");
  const fields = () =>
    strapi.plugin("translate").service("translatable-fields");
  const sourceKey = (uid, id, locale) => state().key("source", uid, id, locale);
  const baselineKey = (uid, id, source, target) =>
    state().key("baseline", uid, id, source, target);
  let installed = false;
  const recoveries = new Map();
  const enabled = (uid, locale) => {
    const cfg = strapi.plugin("translate").config || {};
    const selective = cfg.selectiveTranslation || {};
    const schema = strapi.getModel(uid);
    return (
      selective.enabled !== false &&
      selective.mode !== "off" &&
      schema?.pluginOptions?.i18n?.localized &&
      (!selective.contentTypes?.length ||
        selective.contentTypes.includes(uid)) &&
      (selective.sourceLocales || [cfg.sourceLocale || "de"]).includes(locale)
    );
  };
  const load = (uid, documentId, locale) =>
    strapi.documents(uid).findOne({
      documentId,
      locale,
      status: "draft",
      populate: fields().buildPopulate(uid),
    });
  const summaries = (ops, tree) => {
    const modules = new Map();
    for (const op of ops) {
      const key = op.moduleKey;
      if (!modules.has(key))
        modules.set(key, {
          key,
          label: tree.nodes[key]?.label || op.name,
          path: tree.nodes[key]?.path.join(".") || op.path.join("."),
          fields: [],
        });
      modules.get(key).fields.push({
        id: op.id,
        name: op.name,
        kind: op.kind,
        type: op.type,
        path: op.path,
      });
    }
    return [...modules.values()];
  };
  return {
    enabled,
    load,
    summaries,
    install() {
      if (installed || !strapi.documents?.use) return;
      installed = true;
      strapi.documents.use(async (ctx, next) => {
        if (
          ctx.action !== "update" ||
          !ctx.params.documentId ||
          !ctx.contentType?.pluginOptions?.i18n?.localized ||
          state().isTranslation()
        )
          return next();
        const locale =
          ctx.params.locale ||
          (await strapi.plugin("i18n").service("locales").getDefaultLocale());
        // Even ordinary target edits take the lock used by preview acceptance.
        // The source save and its change record become visible together.
        return state().transaction(async ({ trx }) => {
          await state().lockDocuments(trx, [
            { uid: ctx.uid, documentId: ctx.params.documentId },
          ]);
          if (!enabled(ctx.uid, locale)) return next();
          let previous, before;
          try {
            previous = await load(ctx.uid, ctx.params.documentId, locale);
            if (previous) before = snapshot(strapi, ctx.uid, previous);
          } catch (err) {
            strapi.log.warn(
              `[translate] change tracking unavailable before save: ${err.message}`,
            );
          }
          const result = await next();
          if (!before) return result;
          // A savepoint isolates metadata failures from the editor's source
          // save. The source remains saved, and Retry can persist this record.
          /** @type {any} */
          let pending;
          try {
            await trx.transaction(async () => {
              const current = await load(
                ctx.uid,
                ctx.params.documentId,
                locale,
              );
              if (!current) return;
              const after = snapshot(strapi, ctx.uid, current);
              if (!operations(before, after).length) return;
              const key = sourceKey(ctx.uid, current.documentId, locale);
              const record = recoveries.get(key) || (await state().read(key));
              pending = {
                key,
                value: {
                  version: 1,
                  uid: ctx.uid,
                  documentId: current.documentId,
                  sourceLocale: locale,
                  initial: record?.value?.initial || record?.initial || before,
                  current: after,
                  revision: fingerprint(after),
                  savedAt: Date.now(),
                  actingUserId:
                    strapi.requestContext?.get()?.state?.user?.id || null,
                },
              };
              await state().write(key, pending.value);
              recoveries.delete(key);
            });
          } catch (err) {
            if (pending) recoveries.set(pending.key, pending);
            strapi.log.warn(
              `[translate] source saved but change tracking needs retry: ${err.message}`,
            );
          }
          return result;
        });
      });
    },
    async get({ uid, documentId, sourceLocale, targetLocale, actingUserId }) {
      if (!enabled(uid, sourceLocale)) return { enabled: false, modules: [] };
      const sourceStateKey = sourceKey(uid, documentId, sourceLocale);
      if (recoveries.has(sourceStateKey)) {
        const recovery = recoveries.get(sourceStateKey);
        try {
          await state().transaction(async ({ trx }) => {
            await state().lockDocuments(trx, [{ uid, documentId }]);
            await state().write(sourceStateKey, recovery.value);
          });
          recoveries.delete(sourceStateKey);
        } catch {
          throw problem(
            "The page was saved, but translation tracking needs a retry. Try again after storage is available.",
            503,
          );
        }
      }
      const record = await state().read(sourceStateKey);
      if (!record) return { enabled: true, modules: [], revision: null };
      const current = await load(uid, documentId, sourceLocale);
      if (!current) throw problem("The source document was deleted.", 404);
      const tree = snapshot(strapi, uid, current);
      if (fingerprint(tree) !== record.revision)
        throw problem(
          "Source tracking is out of date. Save the source again before translating.",
        );
      const baseline = targetLocale
        ? await state().read(
            baselineKey(uid, documentId, sourceLocale, targetLocale),
          )
        : null;
      let ops = operations(baseline?.snapshot || record.initial, tree);
      if (!targetLocale) {
        const locales = await strapi
          .plugin("translate")
          .service("locales")
          .codes();
        const pending = new Map();
        for (const locale of locales) {
          if (locale === sourceLocale) continue;
          const targetBaseline = await state().read(
            baselineKey(uid, documentId, sourceLocale, locale),
          );
          for (const op of operations(
            targetBaseline?.snapshot || record.initial,
            tree,
          ))
            pending.set(op.id, op);
        }
        ops = [...pending.values()];
      }
      const cfg = strapi.plugin("translate").config || {};
      const automatic =
        cfg.autoTranslate?.enabled !== false &&
        cfg.autoTranslate?.rules?.some(
          (r) =>
            r.uid === uid &&
            (!r.sourceLocale || r.sourceLocale === sourceLocale) &&
            (!r.on || r.on === "update"),
        );
      return {
        enabled: true,
        revision: record.revision,
        savedAt: record.savedAt,
        shouldPrompt:
          !automatic && !!actingUserId && actingUserId === record.actingUserId,
        modules: summaries(ops, tree),
      };
    },
    async prepare({
      uid,
      documentId,
      sourceLocale,
      targetLocale,
      revision,
      moduleKeys,
      alignments = {},
      initialTranslation = false,
    }) {
      const record = await state().read(
        sourceKey(uid, documentId, sourceLocale),
      );
      if (!record)
        throw problem("No saved changes are available. Save the source first.");
      if (revision && revision !== record.revision)
        throw problem("The source changed. Refresh the saved changes.");
      const source = await load(uid, documentId, sourceLocale);
      const current = snapshot(strapi, uid, source);
      if (fingerprint(current) !== record.revision)
        throw problem("The source changed. Save it again.");
      const target = await load(uid, documentId, targetLocale);
      if (!target && !initialTranslation)
        throw problem(
          `No ${targetLocale} page exists. Choose initial full translation.`,
        );
      const baseline = await state().read(
        baselineKey(uid, documentId, sourceLocale, targetLocale),
      );
      const before = baseline?.snapshot || record.initial;
      const targetTree = target ? snapshot(strapi, uid, target) : null;
      const alignment = target
        ? align(before, targetTree, baseline?.mapping, alignments)
        : { mapping: {}, unresolved: [] };
      // Only unresolved identities touched by this patch need matching.
      let ops = !target
        ? Object.values(current.fields).map((f) => ({
            ...f,
            id: f.key,
            kind: "field",
          }))
        : operations(before, current);
      if (target) {
        const affected = new Set(ops.map((op) => op.moduleKey));
        for (const f of Object.values(current.fields)) {
          if (
            f.type === "relation" &&
            affected.has(f.moduleKey) &&
            !ops.some((op) => op.id === f.key)
          ) {
            ops.push({
              ...f,
              id: f.key,
              kind: "field",
              implicitRelation: true,
            });
          }
        }
      }
      if (target && moduleKeys?.length)
        ops = ops.filter((op) => moduleKeys.includes(op.moduleKey));
      const nodeKeys = new Set(
        ops.flatMap((op) => [op.nodeKey, ...(op.beforeItems || [])]),
      );
      const unresolved = alignment.unresolved.filter((row) =>
        [...nodeKeys].some(
          (k) => k === row.sourceKey || k.startsWith(`${row.sourceKey}/`),
        ),
      );
      return {
        uid,
        documentId,
        sourceLocale,
        targetLocale,
        source,
        current,
        before,
        target,
        targetTree,
        mapping: alignment.mapping,
        unresolved,
        ops,
        sourceRevision: record.revision,
        initialTranslation: !target,
      };
    },
    async applied(prepared, acceptedOps, savedTarget) {
      const key = baselineKey(
        prepared.uid,
        prepared.documentId,
        prepared.sourceLocale,
        prepared.targetLocale,
      );
      const old = await state().read(key);
      const baseline = clone(old?.snapshot || prepared.before);
      for (const op of acceptedOps) {
        if (op.kind === "field")
          baseline.fields[op.id] = clone(prepared.current.fields[op.id]);
        else {
          const prefix = `${op.id}:`;
          // Structural acceptance advances membership/order, but not source
          // text for an existing module whose field edit was excluded.
          const existingFields = clone(baseline.fields);
          for (const collection of [
            baseline.nodes,
            baseline.fields,
            baseline.containers,
          ]) {
            for (const k of Object.keys(collection))
              if (k.startsWith(prefix)) delete collection[k];
          }
          for (const kind of ["nodes", "fields", "containers"]) {
            for (const [k, v] of Object.entries(prepared.current[kind])) {
              if (!k.startsWith(prefix)) continue;
              baseline[kind][k] =
                kind === "fields" && existingFields[k]
                  ? { ...clone(v), value: existingFields[k].value }
                  : clone(v);
            }
          }
          baseline.containers[op.id] = clone(
            prepared.current.containers[op.id],
          );
        }
      }
      if (prepared.initialTranslation)
        Object.assign(baseline, clone(prepared.current));
      const savedTree = snapshot(strapi, prepared.uid, savedTarget);
      // Mapping paths are produced by our own merge; no guessing between
      // separately edited arrays. Re-read allocated target component IDs.
      const mapping = Object.fromEntries(
        Object.entries(prepared.mapping).filter(([k]) => baseline.nodes[k]),
      );
      for (const [sourceKey, targetPath] of Object.entries(
        prepared.appliedPaths || {},
      )) {
        const node = Object.values(savedTree.nodes).find(
          (n) => fingerprint(n.path) === fingerprint(targetPath),
        );
        if (node) mapping[sourceKey] = node.key;
      }
      await state().write(key, { version: 1, snapshot: baseline, mapping });
    },
    async recordFull({ uid, documentId, sourceLocale, targetLocale }) {
      const source = await load(uid, documentId, sourceLocale),
        target = await load(uid, documentId, targetLocale);
      if (!source || !target) return;
      const a = snapshot(strapi, uid, source),
        b = snapshot(strapi, uid, target),
        mapping = { root: "root" };
      for (const node of Object.values(a.nodes)) {
        const match = Object.values(b.nodes).find(
          (n) =>
            n.uid === node.uid &&
            fingerprint(n.path) === fingerprint(node.path),
        );
        if (match) mapping[node.key] = match.key;
      }
      await state().write(
        baselineKey(uid, documentId, sourceLocale, targetLocale),
        { version: 1, snapshot: a, mapping },
      );
    },
  };
};
