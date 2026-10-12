export default {
  schema: {
    kind: "collectionType",
    collectionName: "translate_state",
    info: {
      singularName: "state",
      pluralName: "states",
      displayName: "Translation state",
    },
    options: { draftAndPublish: false },
    pluginOptions: {
      "content-manager": { visible: false },
      "content-type-builder": { visible: false },
    },
    attributes: {
      key: { type: "string", required: true, unique: true },
      value: { type: "json", required: true },
      expiresAt: { type: "datetime" },
    },
  },
};
