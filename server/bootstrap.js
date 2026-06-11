// Runs after register(). Restores any persisted job state, wires the
// auto-translate lifecycle hooks, and registers the admin action that
// gates settings/cache mutations.

export default async ({ strapi }) => {
  // Register the `plugin::translate.settings` admin action so it can be
  // granted/revoked per role in the admin UI and enforced by the
  // hasSettingsPermission policy on plugin-global mutation routes.
  try {
    await strapi
      .service("admin::permission")
      .actionProvider.registerMany([
        {
          section: "plugins",
          displayName: "Manage settings, glossary, and cache",
          uid: "settings",
          pluginName: "translate",
        },
      ]);
  } catch (err) {
    strapi.log?.warn?.(
      `[translate] admin action registration failed: ${err?.message || err}`
    );
  }

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
