"use strict";

// Permission policy for translate-plugin routes that mutate plugin-global
// state (settings, glossary, voice, cache). Gates on the dedicated
// `plugin::translate.settings` admin action registered in bootstrap.js.

const { policy } = require("@strapi/utils");

const ACTION_ID = "plugin::translate.settings";

module.exports = policy.createPolicy({
  name: "plugin::translate.hasSettingsPermission",
  handler(ctx) {
    const { userAbility } = ctx.state;
    if (!userAbility) return false;
    return userAbility.can(ACTION_ID);
  },
});

module.exports.ACTION_ID = ACTION_ID;
