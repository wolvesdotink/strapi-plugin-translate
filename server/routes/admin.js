"use strict";

// Admin-scoped routes for the translate plugin. Mounted at /translate/* under
// the admin API host (requires authenticated admin session).

module.exports = [
  {
    method: "POST",
    path: "/document",
    handler: "translate.translateDocument",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "POST",
    path: "/bulk",
    handler: "translate.bulkTranslate",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "GET",
    path: "/jobs/:id",
    handler: "translate.getJob",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "POST",
    path: "/jobs/:id/cancel",
    handler: "translate.cancelJob",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "GET",
    path: "/usage",
    handler: "translate.usage",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "POST",
    path: "/estimate",
    handler: "translate.estimate",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "GET",
    path: "/locales",
    handler: "translate.locales",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "GET",
    path: "/settings",
    handler: "translate.getSettings",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "PUT",
    path: "/settings",
    handler: "translate.updateSettings",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "POST",
    path: "/settings/reset",
    handler: "translate.resetSettings",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "POST",
    path: "/preview",
    handler: "translate.createPreview",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "GET",
    path: "/preview/:id",
    handler: "translate.getPreview",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "POST",
    path: "/preview/:id/accept",
    handler: "translate.acceptPreview",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "POST",
    path: "/preview/:id/discard",
    handler: "translate.discardPreview",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "GET",
    path: "/cache/stats",
    handler: "translate.cacheStats",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
  {
    method: "DELETE",
    path: "/cache",
    handler: "translate.clearCache",
    config: {
      policies: ["admin::isAuthenticatedAdmin"],
    },
  },
];
