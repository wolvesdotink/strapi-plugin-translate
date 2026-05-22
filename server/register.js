"use strict";

// Runs at plugin registration (before bootstrap). Wires the configured provider
// and loads the glossary so they are ready by the time controllers are called.

const path = require("path");
const fs = require("fs");

const providers = require("./providers");

module.exports = ({ strapi }) => {
  const pluginConfig = strapi.config.get("plugin::translate") || {};
  const providerName = pluginConfig.provider || "openrouter";
  const providerOptions = pluginConfig.providerOptions || {};
  const settings = pluginConfig.settings || {};

  // Resolve glossary file (path is relative to project root if not absolute).
  // This is only the *default* glossary — admins can override at runtime via
  // the Settings page (stored in strapi.store and read by services/settings.js).
  let glossary = { preserveExact: [], perLocale: {} };
  if (settings.glossaryPath) {
    const glossaryPath = path.isAbsolute(settings.glossaryPath)
      ? settings.glossaryPath
      : path.join(strapi.dirs.app.root, settings.glossaryPath);
    try {
      if (fs.existsSync(glossaryPath)) {
        glossary = JSON.parse(fs.readFileSync(glossaryPath, "utf-8"));
        strapi.log.info(
          `[translate] loaded default glossary from ${glossaryPath} (${
            (glossary.preserveExact || []).length
          } preserved terms)`
        );
      } else {
        strapi.log.warn(
          `[translate] glossary path ${glossaryPath} does not exist; continuing without`
        );
      }
    } catch (err) {
      strapi.log.error(
        `[translate] failed to parse glossary file ${glossaryPath}: ${err.message}`
      );
    }
  }

  // Init provider via the registry. Throws with a clear list of registered
  // providers if `providerName` is misconfigured.
  const providerInit = providers.resolve(providerName);
  if (!providerOptions.apiKey) {
    strapi.log.warn(
      `[translate] provider '${providerName}' has no apiKey — translation calls will fail at request time`
    );
  }
  const provider = providerInit({ providerOptions });

  // Stash on the plugin namespace:
  //   provider — the OpenRouter client
  //   config   — non-user-editable knobs (sourceLocale, maxInputCharsPerChunk,
  //              perItemChunks, maxConcurrentChunks) read by services/translate.js
  //   defaults — fallback for the user-editable voice + glossary, seeded into
  //              strapi.store on first read by services/settings.js
  strapi.plugin("translate").provider = provider;
  strapi.plugin("translate").config = settings;
  strapi.plugin("translate").defaults = {
    voice: typeof settings.voice === "string" ? settings.voice : "",
    glossary: {
      preserveExact: Array.isArray(glossary.preserveExact)
        ? glossary.preserveExact
        : [],
      perLocale:
        glossary.perLocale && typeof glossary.perLocale === "object"
          ? glossary.perLocale
          : {},
    },
  };
};
