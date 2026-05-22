// Admin entry. Registers the plugin and injects a "Translate" Document Action
// into the content-manager Edit View — the dropdown next to Save/Publish.

import pluginId from "./pluginId";
import TranslateAction from "./components/TranslateAction";

export default {
  register(app) {
    app.registerPlugin({
      id: pluginId,
      name: "Translate",
    });

    // Inject the document action. Strapi v5 calls this factory with the
    // current document context; we return a descriptor (icon or button + dialog).
    app
      .getPlugin("content-manager")
      .apis.addDocumentAction((actions) => [...actions, TranslateAction]);

    // Register the settings page under Settings → Translate. The Component
    // factory is loaded lazily so the form code only enters the bundle when
    // an admin opens the page.
    app.createSettingSection(
      {
        id: pluginId,
        intlLabel: {
          id: `${pluginId}.settings.section`,
          defaultMessage: "Translate",
        },
      },
      [
        {
          id: `${pluginId}-settings`,
          intlLabel: {
            id: `${pluginId}.settings.menu`,
            defaultMessage: "Configuration",
          },
          to: `/settings/${pluginId}`,
          Component: () => import("./pages/Settings"),
          permissions: [],
        },
      ]
    );
  },

  bootstrap() {},

  async registerTrads({ locales }) {
    const importedTrads = await Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = await import(
            `./translations/${locale}.json`
          );
          return {
            data: prefixed(data, pluginId),
            locale,
          };
        } catch {
          return { data: {}, locale };
        }
      })
    );
    return importedTrads;
  },
};

// Inline replacement for the deprecated @strapi/helper-plugin prefixPluginTranslations.
function prefixed(trad, pluginId) {
  return Object.keys(trad).reduce((acc, key) => {
    acc[`${pluginId}.${key}`] = trad[key];
    return acc;
  }, {});
}
