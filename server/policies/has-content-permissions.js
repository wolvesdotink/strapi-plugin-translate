"use strict";

// Permission policy for translate-plugin routes that target a specific
// content-type uid supplied in the request body.
//
// Mirrors `plugin::content-manager.hasPermissions` but reads `uid` from
// `ctx.request.body.uid` instead of `ctx.params.model`, since this plugin's
// routes pass the model in the body rather than the URL path.
//
// Config:
//   actions:       array of action ids the caller must hold against `uid`
//   sourceActions: actions checked against `body.sourceUid` if present
//                  (falls back to `body.uid` for routes where source and
//                  target are the same content type)
//   hasAtLeastOne: boolean — when true, any one matching action is enough

const { policy } = require("@strapi/utils");

module.exports = policy.createPolicy({
  name: "plugin::translate.hasContentPermissions",
  handler(ctx, config = {}) {
    const { actions = [], sourceActions = [], hasAtLeastOne = false } = config;
    const { userAbility } = ctx.state;
    if (!userAbility) return false;

    const body = ctx.request.body || {};
    const uid = body.uid;
    if (!uid || typeof uid !== "string") return false;

    const sourceUid =
      typeof body.sourceUid === "string" && body.sourceUid ? body.sourceUid : uid;

    const check = (actionList, subject) => {
      if (actionList.length === 0) return true;
      return hasAtLeastOne
        ? actionList.some((action) => userAbility.can(action, subject))
        : actionList.every((action) => userAbility.can(action, subject));
    };

    return check(actions, uid) && check(sourceActions, sourceUid);
  },
});
