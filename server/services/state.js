import { AsyncLocalStorage } from "node:async_hooks";
import { clone, fingerprint } from "./content-tree";

const UID = "plugin::translate.state";
// Context follows asynchronous writes and is isolated per job/request. No
// process-global in-flight flag can suppress another editor's source save.
const provenance = new AsyncLocalStorage();
export default ({ strapi }) => ({
  key(kind, ...parts) {
    return `${kind}:${fingerprint(parts)}`;
  },
  async read(key) {
    const row = await strapi.db.query(UID).findOne({ where: { key } });
    if (
      !row ||
      (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now())
    )
      return null;
    return clone(row.value);
  },
  async write(key, value, ttl) {
    const query = strapi.db.query(UID);
    const existing = await query.findOne({ where: { key } });
    const data = {
      key,
      value: clone(value),
      expiresAt: ttl ? new Date(Date.now() + ttl).toISOString() : null,
    };
    return existing
      ? query.update({ where: { key }, data })
      : query.create({ data });
  },
  async remove(key) {
    await strapi.db.query(UID).delete({ where: { key } });
  },
  async cleanup() {
    await strapi.db
      .query(UID)
      .deleteMany({ where: { expiresAt: { $lt: new Date().toISOString() } } });
  },
  isTranslation() {
    return !!provenance.getStore();
  },
  runTranslation(fn) {
    return provenance.run(true, fn);
  },
  async transaction(fn) {
    return strapi.db.transaction(fn);
  },
  // All scoped applies and ordinary tracked document updates acquire these
  // same row locks. Source/target checks and writes share the transaction.
  async lockDocuments(trx, documents) {
    for (const { uid, documentId } of [...documents].sort((a, b) =>
      `${a.uid}:${a.documentId}`.localeCompare(`${b.uid}:${b.documentId}`),
    )) {
      const metadata = strapi.db.metadata.get(uid);
      await trx(metadata.tableName)
        .where(metadata.attributes.documentId.columnName, documentId)
        .orderBy("id")
        .forUpdate()
        .select("id");
    }
  },
});
