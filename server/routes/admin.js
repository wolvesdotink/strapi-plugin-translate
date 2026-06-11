// Admin-scoped routes for the translate plugin. Mounted at /translate/* under
// the admin API host (requires authenticated admin session).
//
// Permission model
// ----------------
// `admin::isAuthenticatedAdmin` only verifies that a valid admin session is
// present. It does NOT enforce per-content-type RBAC, so every route that
// touches a specific content type also goes through
// `plugin::translate.hasContentPermissions`, which reads `uid` from the
// request body and runs `userAbility.can(action, uid)` for each declared
// action — the same check `plugin::content-manager.hasPermissions` performs,
// but adapted to our body-based uid convention.
//
// Routes that mutate plugin-global state (settings, glossary, cache) are
// gated on `plugin::translate.hasSettingsPermission`, backed by the
// `plugin::translate.settings` admin action registered in bootstrap.js.
//
// Preview-by-id routes (GET /preview/:id, POST /preview/:id/accept,
// POST /preview/:id/discard) cannot use the route-level policy because the
// uid lives in the stored preview row rather than the request — the
// controller loads the row first and then calls the
// `plugin::content-manager.explorer.*` ability checks inline.

const READ_ACTION = "plugin::content-manager.explorer.read";
const UPDATE_ACTION = "plugin::content-manager.explorer.update";

// Authenticated admin + read+update permissions on the request body's `uid`.
const contentPermissions = (extraActions = []) => [
  "admin::isAuthenticatedAdmin",
  {
    name: "plugin::translate.hasContentPermissions",
    config: { actions: [READ_ACTION, UPDATE_ACTION, ...extraActions] },
  },
];

// Authenticated admin + read-only permission on the request body's `uid`.
const contentReadPermissions = () => [
  "admin::isAuthenticatedAdmin",
  {
    name: "plugin::translate.hasContentPermissions",
    config: { actions: [READ_ACTION] },
  },
];

// Authenticated admin + the dedicated `plugin::translate.settings` action.
const settingsPermissions = () => [
  "admin::isAuthenticatedAdmin",
  { name: "plugin::translate.hasSettingsPermission" },
];

// Authenticated admin only — used for endpoints that neither target a
// specific content type nor mutate plugin state (job polling, usage,
// supported locales, read-only settings/cache views).
const authedOnly = () => ["admin::isAuthenticatedAdmin"];

export default [
  {
    method: "POST",
    path: "/document",
    handler: "translate.translateDocument",
    config: { policies: contentPermissions() },
  },
  {
    method: "POST",
    path: "/bulk",
    handler: "translate.bulkTranslate",
    config: { policies: contentPermissions() },
  },
  {
    method: "GET",
    path: "/jobs",
    handler: "translate.listJobs",
    config: { policies: authedOnly() },
  },
  {
    method: "GET",
    path: "/jobs/:id",
    handler: "translate.getJob",
    config: { policies: authedOnly() },
  },
  {
    method: "POST",
    path: "/jobs/:id/cancel",
    handler: "translate.cancelJob",
    config: { policies: authedOnly() },
  },
  {
    method: "GET",
    path: "/usage",
    handler: "translate.usage",
    config: { policies: authedOnly() },
  },
  {
    method: "POST",
    path: "/estimate",
    handler: "translate.estimate",
    config: { policies: contentReadPermissions() },
  },
  {
    method: "GET",
    path: "/locales",
    handler: "translate.locales",
    config: { policies: authedOnly() },
  },
  {
    method: "GET",
    path: "/settings",
    handler: "translate.getSettings",
    config: { policies: authedOnly() },
  },
  {
    method: "PUT",
    path: "/settings",
    handler: "translate.updateSettings",
    config: { policies: settingsPermissions() },
  },
  {
    method: "POST",
    path: "/settings/reset",
    handler: "translate.resetSettings",
    config: { policies: settingsPermissions() },
  },
  {
    method: "POST",
    path: "/preview",
    handler: "translate.createPreview",
    config: { policies: contentPermissions() },
  },
  {
    method: "GET",
    path: "/preview/:id",
    handler: "translate.getPreview",
    config: { policies: authedOnly() },
  },
  {
    method: "POST",
    path: "/preview/:id/accept",
    handler: "translate.acceptPreview",
    config: { policies: authedOnly() },
  },
  {
    method: "POST",
    path: "/preview/:id/discard",
    handler: "translate.discardPreview",
    config: { policies: authedOnly() },
  },
  {
    method: "GET",
    path: "/cache/stats",
    handler: "translate.cacheStats",
    config: { policies: authedOnly() },
  },
  {
    method: "DELETE",
    path: "/cache",
    handler: "translate.clearCache",
    config: { policies: settingsPermissions() },
  },
  {
    method: "POST",
    path: "/content/locale-status",
    handler: "translate.localeStatus",
    config: { policies: contentReadPermissions() },
  },
  {
    method: "GET",
    path: "/content-types",
    handler: "translate.contentTypes",
    config: { policies: authedOnly() },
  },
  {
    method: "POST",
    path: "/content/list",
    handler: "translate.contentList",
    config: { policies: contentReadPermissions() },
  },
];
