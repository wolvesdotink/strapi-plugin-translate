// Plugin-scoped policies. Once registered here and wired through
// server/index.js, they are referenceable as `plugin::translate.<name>`
// in routes/admin.js.

import hasContentPermissions from "./has-content-permissions";
import hasSettingsPermission from "./has-settings-permission";

export default {
  hasContentPermissions,
  hasSettingsPermission,
};
