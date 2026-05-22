"use strict";

// Runs after register(). Restores any persisted job state and wires the
// auto-translate lifecycle hooks.

module.exports = async ({ strapi }) => {
  // Recover persisted jobs — anything that was in-flight at restart is
  // marked failed so the UI doesn't poll forever.
  try {
    const jobs = strapi.plugin("translate").service("jobs");
    if (jobs && typeof jobs.restoreFromStore === "function") {
      await jobs.restoreFromStore();
    }
  } catch (err) {
    strapi.log?.warn?.(
      `[translate] bootstrap job restore failed: ${err?.message || err}`
    );
  }

  // Wire auto-translate lifecycle hooks if configured.
  try {
    const autoTranslate = strapi.plugin("translate").service("auto-translate");
    if (autoTranslate && typeof autoTranslate.install === "function") {
      autoTranslate.install();
    }
  } catch (err) {
    strapi.log?.warn?.(
      `[translate] auto-translate install failed: ${err?.message || err}`
    );
  }
};
