"use strict";

// Plugin-scoped policies. Once registered here and wired through
// server/index.js, they are referenceable as `plugin::translate.<name>`
// in routes/admin.js.

const hasContentPermissions = require("./has-content-permissions");
const hasSettingsPermission = require("./has-settings-permission");

module.exports = {
  hasContentPermissions,
  hasSettingsPermission,
};
