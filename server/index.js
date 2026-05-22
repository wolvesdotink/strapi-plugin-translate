"use strict";

// Plugin server entry. Registers lifecycle hooks, controllers, services, and routes.
// This is the shape Strapi v5 expects from a local plugin's server export.

const register = require("./register");
const bootstrap = require("./bootstrap");

const translateController = require("./controllers/translate");
const translateService = require("./services/translate");
const translatableFieldsService = require("./services/translatable-fields");
const formatService = require("./services/format");
const glossaryService = require("./services/glossary");
const chunksService = require("./services/chunks");
const jobsService = require("./services/jobs");
const settingsService = require("./services/settings");
const localesService = require("./services/locales");
const cacheService = require("./services/cache");
const previewService = require("./services/preview");
const autoTranslateService = require("./services/auto-translate");
const backTranslateService = require("./services/back-translate");

const adminRoutes = require("./routes/admin");
const policies = require("./policies");

module.exports = {
  register,
  bootstrap,

  controllers: {
    translate: translateController,
  },

  policies,

  services: {
    translate: translateService,
    "translatable-fields": translatableFieldsService,
    format: formatService,
    glossary: glossaryService,
    chunks: chunksService,
    jobs: jobsService,
    settings: settingsService,
    locales: localesService,
    cache: cacheService,
    preview: previewService,
    "auto-translate": autoTranslateService,
    "back-translate": backTranslateService,
  },

  routes: {
    admin: {
      type: "admin",
      routes: adminRoutes,
    },
  },
};
