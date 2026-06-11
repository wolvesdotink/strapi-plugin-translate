// Permission policy for translate-plugin routes that mutate plugin-global
// state (settings, glossary, voice, cache). Gates on the dedicated
// `plugin::translate.settings` admin action registered in bootstrap.js.

import { policy } from "@strapi/utils";

const ACTION_ID = "plugin::translate.settings";

export default policy.createPolicy({
  name: "plugin::translate.hasSettingsPermission",
  handler(ctx) {
    const { userAbility } = ctx.state;
    if (!userAbility) return false;
    return userAbility.can(ACTION_ID);
  },
});

export { ACTION_ID };
