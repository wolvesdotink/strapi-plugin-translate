// Plugin server entry. Registers lifecycle hooks, controllers, services, and routes.
// This is the shape Strapi v5 expects from a local plugin's server export.

import register from "./register";
import bootstrap from "./bootstrap";

import translateController from "./controllers/translate";
import translateService from "./services/translate";
import translatableFieldsService from "./services/translatable-fields";
import formatService from "./services/format";
import glossaryService from "./services/glossary";
import chunksService from "./services/chunks";
import jobsService from "./services/jobs";
import settingsService from "./services/settings";
import localesService from "./services/locales";
import cacheService from "./services/cache";
import previewService from "./services/preview";
import autoTranslateService from "./services/auto-translate";
import backTranslateService from "./services/back-translate";

import adminRoutes from "./routes/admin";
import policies from "./policies";

export default {
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
