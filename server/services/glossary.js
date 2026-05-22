"use strict";

// Thin accessor for the glossary. Reads through the settings service so
// changes made via the admin Settings page are reflected immediately.
module.exports = ({ strapi }) => ({
  async get() {
    const settings = await strapi
      .plugin("translate")
      .service("settings")
      .get();
    return settings.glossary || { preserveExact: [], perLocale: {} };
  },
});
