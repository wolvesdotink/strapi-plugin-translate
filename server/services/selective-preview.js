import crypto from "node:crypto";
import {
  snapshot,
  fingerprint,
  problem,
  clone,
  get,
  set,
} from "./content-tree";
import {
  selectedPaths,
  mergePatch,
  previewModules,
  targetFingerprint,
} from "./patch";

const TTL = 60 * 60 * 1000;
export default ({ strapi }) => {
  const service = (name) => strapi.plugin("translate").service(name);
  const key = (id) => service("state").key("preview", id);
  const publicPreview = (row) => ({
    previewId: row.id,
    uid: row.prepared.uid,
    documentId: row.prepared.documentId,
    sourceLocale: row.prepared.sourceLocale,
    label:
      row.prepared.source?.title ||
      strapi.getModel(row.prepared.uid).info?.displayName ||
      row.prepared.uid,
    targetLocale: row.prepared.targetLocale,
    modules: row.modules,
    relations: row.relations,
    children: row.children.map((child) => publicPreview(child)),
    warnings: row.warnings,
    applied: row.applied || false,
    result: row.result || null,
    expiresAt: row.expiresAt,
    initialTranslation: row.prepared.initialTranslation,
  });
  const fullPrepared = async (args) => {
    const source = await service("changes").load(
      args.uid,
      args.documentId,
      args.sourceLocale,
    );
    if (!source) throw problem("Linked source item no longer exists.", 404);
    const current = snapshot(strapi, args.uid, source);
    return {
      ...args,
      source,
      current,
      before: current,
      target: null,
      targetTree: null,
      mapping: {},
      unresolved: [],
      initialTranslation: true,
      sourceRevision: fingerprint(current),
      ops: Object.values(current.fields).map((f) => ({
        ...f,
        id: f.key,
        kind: "field",
      })),
    };
  };
  const create = async (args, authorize, child = false) => {
    const prepared = args.forceInitial
      ? await fullPrepared(args)
      : await service("changes").prepare(args);
    if (prepared.unresolved.length)
      throw Object.assign(
        problem("Match the affected modules before generating a preview."),
        { details: { alignments: prepared.unresolved } },
      );
    if (!prepared.ops.length && !prepared.initialTranslation)
      throw problem(`No pending changes for ${args.targetLocale}.`, 400);
    if (authorize) await authorize(prepared);
    let relations = await service("relations").resolve(prepared, null, {
      before: true,
    });
    const children = [];
    if (args.translateLinkedItems && !child) {
      const refs = [
        ...new Map(
          relations.map((r) => [`${r.uid}:${r.documentId}`, r]),
        ).values(),
      ];
      const limit =
        strapi.plugin("translate").config?.selectiveTranslation
          ?.maxLinkedItems || 20;
      if (refs.length > limit)
        throw problem(
          `Select fewer modules: linked-item translation is limited to ${limit} direct items.`,
          400,
        );
      for (const ref of refs) {
        if (ref.uid === prepared.uid && ref.documentId === prepared.documentId)
          continue;
        const childArgs = {
          uid: ref.uid,
          documentId: ref.documentId,
          sourceLocale: args.sourceLocale,
          targetLocale: args.targetLocale,
          actingUserId: args.actingUserId,
          signal: args.signal,
          forceInitial: ref.status === "missing",
          translateLinkedItems: false,
        };
        if (!childArgs.forceInitial) {
          const pending = await service("changes").get(childArgs);
          if (!pending.modules?.length) continue;
        }
        children.push(await create(childArgs, authorize, true));
      }
    }
    const computed = await service("translate").translateDocumentDry({
      ...args,
      sourceEntry: prepared.source,
      selectedPaths: selectedPaths(prepared),
    });
    const proposed = mergePatch(strapi, prepared, computed.proposed);
    relations = await service("relations").resolve(prepared, proposed);
    const modules = previewModules(prepared, proposed, prepared.ops);
    const labels = (v, locale) =>
      (Array.isArray(v) ? v : v ? [v] : []).map(
        (item) =>
          `${item.title || item.name || item.documentId || "Linked item"} (${item.locale || locale})`,
      );
    for (const module of modules)
      for (const field of module.fields) {
        if (field.type !== "relation") continue;
        const descriptor = prepared.current.fields[field.id];
        field.source = labels(
          get(prepared.source, descriptor.path),
          prepared.sourceLocale,
        );
        const targetPath = prepared.appliedPaths[descriptor.nodeKey]?.concat(
          descriptor.name,
        );
        field.before = labels(
          targetPath && get(prepared.target, targetPath),
          prepared.targetLocale,
        );
        field.after = relations
          .filter((r) => r.fieldKey === field.id)
          .map((r) =>
            r.status === "missing"
              ? `Missing ${r.targetLocale} version`
              : `${r.label} (${r.targetLocale})`,
          );
      }
    const row = {
      id: `change_${crypto.randomUUID()}`,
      prepared: clone(prepared),
      computed: clone(computed.proposed),
      modules,
      relations,
      children,
      settingsFingerprint: fingerprint(await service("settings").get()),
      warnings: computed.warnings || [],
      targetFingerprint: targetFingerprint(strapi, args.uid, prepared.target),
      actingUserId: args.actingUserId || null,
      expiresAt: Date.now() + TTL,
    };
    return row;
  };

  const assertCurrent = async (row) => {
    const p = row.prepared;
    if (
      row.settingsFingerprint !== fingerprint(await service("settings").get())
    )
      throw problem("Translation settings changed. Generate a new preview.");
    const source = await service("changes").load(
      p.uid,
      p.documentId,
      p.sourceLocale,
    );
    const target = await service("changes").load(
      p.uid,
      p.documentId,
      p.targetLocale,
    );
    if (
      !source ||
      fingerprint(snapshot(strapi, p.uid, source)) !== p.sourceRevision
    )
      throw problem(
        "The source changed since this preview. Generate a new preview.",
      );
    if (targetFingerprint(strapi, p.uid, target) !== row.targetFingerprint)
      throw problem(
        "The target changed since this preview. Generate a new preview to keep those edits.",
      );
  };

  const applyRow = async (row, options, authorize) => {
    if (row.applied) return row.result;
    await assertCurrent(row);
    if (authorize) await authorize(row.prepared);
    const excluded = new Set(options.excludedOperations || []);
    const ops = row.prepared.ops.filter((op) => !excluded.has(op.id));
    if (!ops.length && !row.prepared.initialTranslation)
      throw problem("Select at least one change to apply.", 400);
    // Child previews are separate records of proposed work. A parent accept
    // applies this locale's approved child changes in the same transaction.
    for (const child of row.children) {
      const childExcluded = options.childExcludedOperations?.[child.id] || [];
      if (
        !child.prepared.initialTranslation &&
        child.prepared.ops.every((op) => childExcluded.includes(op.id))
      )
        continue;
      await applyRow(
        child,
        {
          excludedOperations: childExcluded,
          allowMissingRelations:
            options.childAllowMissingRelations?.[child.id] === true,
          actingUserId: options.actingUserId,
        },
        authorize,
      );
    }
    const proposed = mergePatch(strapi, row.prepared, row.computed, ops);
    const relationFields = new Set(
      ops
        .filter((op) => op.kind === "field" && op.type === "relation")
        .map((op) => op.id),
    );
    const relations = await service("relations").resolve(
      row.prepared,
      proposed,
      {
        operations: ops,
        selectedModules: ops.map((op) => op.moduleKey),
        selectedFields: row.prepared.initialTranslation
          ? undefined
          : relationFields,
      },
    );
    const unresolved = relations.filter((r) => r.status === "missing");
    if (
      unresolved.some((r) => r.required) ||
      (unresolved.length && !options.allowMissingRelations)
    )
      throw problem(
        "Some linked items have no target-language version. Translate them or explicitly omit optional links.",
      );
    // Recheck field-level write permissions against the actual merged payload.
    if (authorize) await authorize({ ...row.prepared, proposed });
    let entry;
    try {
      entry = await service("state").runTranslation(() =>
        service("translate").commitPreview(
          {
            uid: row.prepared.uid,
            documentId: row.prepared.documentId,
            targetLocale: row.prepared.targetLocale,
            proposed,
            actingUserId: options.actingUserId || row.actingUserId,
            translatedPaths: ops
              .filter(
                (op) => op.kind === "field" && op.directive === "translate",
              )
              .map((op) =>
                row.prepared.appliedPaths[op.nodeKey].concat(op.name).join("."),
              ),
          },
          { reviewRepairs: true, preserveWorkflow: true },
        ),
      );
    } catch (err) {
      if (err.repairs) {
        err.repairPreviewId = row.id;
        err.reviewRepairs = err.repairs
          .map((repair) => {
            const op = ops.find(
              (op) =>
                op.kind === "field" &&
                row.prepared.appliedPaths[op.nodeKey]
                  ?.concat(op.name)
                  .join(".") === repair.path,
            );
            return op
              ? {
                  id: op.id,
                  sourcePath: op.path,
                  after: repair.after,
                  message: repair.message,
                }
              : null;
          })
          .filter(Boolean);
      }
      throw err;
    }
    const savedTarget = await service("changes").load(
      row.prepared.uid,
      row.prepared.documentId,
      row.prepared.targetLocale,
    );
    await service("changes").applied(row.prepared, ops, savedTarget);
    row.applied = true;
    row.result = {
      ok: true,
      documentId: entry.documentId,
      locale: entry.locale,
      warnings: row.warnings,
      linkedItems: row.children.map((c) => c.result).filter(Boolean),
    };
    return row.result;
  };

  return {
    publicPreview,
    async estimate(args, authorize) {
      const estimates = [];
      for (const targetLocale of args.targetLocales) {
        if (targetLocale === args.sourceLocale)
          throw problem("Source and target language must differ.", 400);
        const prepared = await service("changes").prepare({
          ...args,
          targetLocale,
          alignments: args.alignments?.[targetLocale] || {},
        });
        if (authorize) await authorize(prepared);
        const entries = [prepared];
        if (args.translateLinkedItems) {
          const relations = await service("relations").resolve(prepared, null, {
            before: true,
          });
          const unique = [
            ...new Map(
              relations.map((r) => [`${r.uid}:${r.documentId}`, r]),
            ).values(),
          ];
          const limit =
            strapi.plugin("translate").config?.selectiveTranslation
              ?.maxLinkedItems || 20;
          if (unique.length > limit)
            throw problem(
              `Linked-item translation is limited to ${limit} direct items.`,
              400,
            );
          for (const ref of unique) {
            if (
              ref.uid === prepared.uid &&
              ref.documentId === prepared.documentId
            )
              continue;
            const childArgs = {
              uid: ref.uid,
              documentId: ref.documentId,
              sourceLocale: args.sourceLocale,
              targetLocale,
            };
            const pending =
              ref.status !== "missing" &&
              (await service("changes").get(childArgs));
            if (ref.status !== "missing" && !pending.modules?.length) continue;
            const child =
              ref.status === "missing"
                ? await fullPrepared(childArgs)
                : await service("changes").prepare(childArgs);
            if (authorize) await authorize(child);
            entries.push(child);
          }
        }
        for (const p of entries)
          estimates.push(
            await service("translate").estimate({
              uid: p.uid,
              documentId: p.documentId,
              sourceLocale: p.sourceLocale,
              targetLocales: [targetLocale],
              selectedPaths: selectedPaths(p),
              sourceEntry: p.source,
            }),
          );
      }
      return {
        inputTokens: estimates.reduce((sum, e) => sum + e.inputTokens, 0),
        estimatedOutputTokens: estimates.reduce(
          (sum, e) => sum + e.estimatedOutputTokens,
          0,
        ),
        estimatedCostUsd: estimates.every(
          (e) => typeof e.estimatedCostUsd === "number",
        )
          ? estimates.reduce((sum, e) => sum + e.estimatedCostUsd, 0)
          : null,
      };
    },
    async create(args, authorize) {
      await service("state").cleanup();
      const row = await create(args, authorize);
      await service("state").write(key(row.id), row, TTL);
      return publicPreview(row);
    },
    async get(id, actingUserId) {
      const row = await service("state").read(key(id));
      if (!row || (actingUserId && row.actingUserId !== actingUserId))
        return null;
      return row;
    },
    async accept(id, options = {}, authorize) {
      try {
        return await service("state").transaction(async ({ trx }) => {
          const meta = strapi.db.metadata.get("plugin::translate.state");
          await trx(meta.tableName)
            .where("key", key(id))
            .forUpdate()
            .select("id");
          const row = await this.get(id, options.actingUserId);
          if (!row) throw problem("Preview expired or not found.", 404);
          if (row.applied) return row.result;
          const documents = [row, ...row.children].flatMap((r) => [
            { uid: r.prepared.uid, documentId: r.prepared.documentId },
            ...r.relations.map((ref) => ({
              uid: ref.uid,
              documentId: ref.documentId,
            })),
          ]);
          await service("state").lockDocuments(trx, documents);
          const result = await applyRow(row, options, authorize);
          await service("state").write(key(id), row, TTL);
          return result;
        });
      } catch (err) {
        if (err.reviewRepairs?.length) {
          const revised = await service("state").transaction(
            async ({ trx }) => {
              const meta = strapi.db.metadata.get("plugin::translate.state");
              await trx(meta.tableName)
                .where("key", key(id))
                .forUpdate()
                .select("id");
              const row = await this.get(id, options.actingUserId);
              if (!row || row.applied)
                throw problem("Preview no longer available for repair.");
              const repairRow =
                err.repairPreviewId === row.id
                  ? row
                  : row.children.find(
                      (child) => child.id === err.repairPreviewId,
                    );
              if (!repairRow)
                throw problem("The preview to repair is no longer available.");
              for (const repair of err.reviewRepairs) {
                set(repairRow.computed, repair.sourcePath, repair.after);
                for (const module of repairRow.modules)
                  for (const field of module.fields)
                    if (field.id === repair.id) field.after = repair.after;
                repairRow.warnings.push({
                  kind: "validation-repair",
                  message: repair.message,
                });
              }
              await service("state").write(key(id), row, TTL);
              return publicPreview(row);
            },
          );
          err.details = { preview: revised };
        }
        throw err;
      }
    },
    async discard(id, actingUserId) {
      return service("state").transaction(async ({ trx }) => {
        const meta = strapi.db.metadata.get("plugin::translate.state");
        await trx(meta.tableName)
          .where("key", key(id))
          .forUpdate()
          .select("id");
        const row = await this.get(id, actingUserId);
        if (!row) throw problem("Preview expired or not found.", 404);
        if (row.applied)
          throw problem("This preview has already been applied.");
        await service("state").remove(key(id));
        return { ok: true };
      });
    },
  };
};
