# RBAC Registry Cleanup Plan

Step 1.4 of platform modularization. Refactors roles and token scopes from
hardcoded lists into the module registry pattern, matching `registerRefresh()`
and `registerDiagnostics()`.

**Status:** Under review
**PR strategy:** Single PR
**Breaking changes:** Yes -- `permissionTier` removed from `/api/whoami` and
all downstream responses/events

---

## Problem Summary

1. `VALID_ROLES` in `shared/server/role-store.js` hardcodes module-specific
   roles (`release-manager`, `usage-metrics-viewer`) in the platform layer.
2. `VALID_SCOPES` in `server/api-tokens.js` explicitly lists every module's
   scopes (`releases:read`, `ai-impact:read`, etc.).
3. Dedicated middleware per role in `shared/server/auth.js`
   (`requireReleaseManager`) leaks module knowledge into platform code.
4. Module-specific middleware is ad-hoc (`requireTeamPurview`,
   `requireManagerOrAdmin`, `requireMetricsViewer`) with no consistent pattern.
5. `permissionTier` is a linear hierarchy conflating orthogonal roles.
6. Boolean flags on `req` (`isTeamAdmin`, `isReleaseManager`) duplicate role
   store lookups.

## Design

### A. Role Registry

New file: `shared/server/role-registry.js`

```js
/**
 * @typedef {object} RoleConfig
 * @property {string} id          - Unique role identifier (e.g. 'release-manager')
 * @property {string} label       - Human-readable label for Settings UI
 * @property {string} description - Short description for Settings UI
 * @property {string} module      - Module slug that registered this role (or 'platform')
 */

function createRoleRegistry() {
  const roles = new Map();

  function register(id, config) {
    if (roles.has(id)) {
      throw new Error(`Role "${id}" is already registered`);
    }
    roles.set(id, Object.freeze({ id, ...config }));
  }

  function isValid(id) {
    return roles.has(id);
  }

  function getAll() {
    return [...roles.values()];
  }

  function get(id) {
    return roles.get(id) || null;
  }

  return Object.freeze({ register, isValid, getAll, get });
}
```

**Platform roles** (registered at startup in `dev-server.js`, before module
loading):
- `admin` -- Full platform access
- `team-admin` -- Team structure management

**Module-registered roles** (via `context.registerRole()`):
- `release-manager` -- registered by releases module

**Platform-level non-module roles** (registered directly on the registry in
`dev-server.js`, NOT via module context):
- `usage-metrics-viewer` -- registered by `dev-server.js` alongside
  health-metrics setup (see section A.1)

#### A.1 Health-Metrics Is NOT a Module

Health-metrics is mounted directly in `dev-server.js` as
`app.use('/api/health-metrics', createHealthMetricsRouter(coreServices))`.
It receives raw `coreServices`, not a `ModuleContext`. It has no
`context.registerRole()` or `context.registerScopes()` available.

Therefore `usage-metrics-viewer` and the `health-metrics:read/write` scopes
are registered **directly on the registries in `dev-server.js`** at startup,
alongside the other platform roles/scopes, before module loading:

```js
// In dev-server.js, after creating registries and platform roles:
roleRegistry.register('usage-metrics-viewer', {
  label: 'Usage Metrics Viewer',
  description: 'Can view health/usage metrics dashboards',
  module: 'health-metrics'  // attribution, not a real module slug
});
scopeRegistry.register('health-metrics:read', { ... });
scopeRegistry.register('health-metrics:write', { ... });
```

If health-metrics is ever promoted to a proper module, these registrations
move into its `server/index.js` via `context.registerRole()` /
`context.registerScopes()`.

### B. Scope Registry

New file: `shared/server/scope-registry.js`

```js
/**
 * @typedef {object} ScopeConfig
 * @property {string} key         - Scope key (e.g. 'releases:read')
 * @property {string} label       - Human label
 * @property {string} description - Short description
 * @property {string} category    - UI grouping
 * @property {string} module      - Module slug (or 'platform')
 */

function createScopeRegistry() {
  const scopes = new Map();

  function register(key, config) {
    if (scopes.has(key)) {
      throw new Error(`Scope "${key}" is already registered`);
    }
    scopes.set(key, Object.freeze({ key, ...config }));
  }

  function isValid(key) {
    return scopes.has(key);
  }

  function getAll() {
    return [...scopes.values()];
  }

  function getValidKeys() {
    return [...scopes.keys()];
  }

  return Object.freeze({ register, isValid, getAll, getValidKeys });
}
```

**Platform scopes** (registered at startup, before module loading):
- `roster:read`, `roster:write`
- `metrics:read`, `metrics:write`
- `github:read`, `github:write`
- `gitlab:read`, `gitlab:write`
- `admin:manage`
- `tokens:manage`

**Platform-level non-module scopes** (registered in `dev-server.js`, see A.1):
- `health-metrics:read`, `health-metrics:write`

**Module-registered scopes** (via `context.registerScopes()`):
- `team-tracker:read`, `team-tracker:write` -- by team-tracker
- `releases:read`, `releases:write` -- by releases
- `ai-impact:read`, `ai-impact:write` -- by ai-impact
- `upstream-pulse:read`, `upstream-pulse:write` -- by upstream-pulse

### C. Generic `requireRole()` Middleware Factory

Replace per-role middleware in `shared/server/auth.js` with a single factory:

```js
function requireRole(role) {
  return function(req, res, next) {
    if (req.isAdmin) return next();  // admin always passes
    if (!roleStore.hasRole(req.userEmail, role)) {
      return res.status(403).json({
        error: `Role "${role}" required.`
      });
    }
    next();
  };
}
```

**Platform shortcuts retained** (thin wrappers):
- `requireAdmin` -- checks `req.isAdmin` (unchanged)
- `requireTeamAdmin` -- calls `requireRole('team-admin')` internally

**Removed from platform:**
- `requireReleaseManager` -- modules use `requireRole('release-manager')`

### D. Module Context Changes

In `shared/server/module-context.js`, add `registerRole` and
`registerScopes` to `ModuleContext`:

```js
// In buildModuleContext():
registerRole: roleRegistry
  ? function(id, config) {
      roleRegistry.register(id, { ...config, module: slug });
    }
  : function() {},

registerScopes: scopeRegistry
  ? function(scopeConfigs) {
      for (const config of scopeConfigs) {
        scopeRegistry.register(config.key, { ...config, module: slug });
      }
    }
  : function() {},
```

Replace `requireReleaseManager` with `requireRole`:

```js
// Before (hardcoded):
requireReleaseManager: coreServices.requireReleaseManager,

// After (generic):
requireRole: coreServices.requireRole,
```

### E. `permissionTier` Removal (Breaking Change)

**Removed from:**
- `req.permissionTier` -- no longer set in auth middleware
- `/api/whoami` response -- field removed
- `getPermissionTier()` in `shared/server/permissions.js` -- function removed
- `useAuth` composable -- `permissionTier` computed removed
- `/api/messages` userContext -- replaced with `roles` + `isManager`
- `/api/modules/team-tracker/permissions/me` response -- `tier` field removed
- Roster API response `permissions.tier` -- replaced with `permissions.roles`
- Health metrics event `permissionTier` field -- replaced with `roles` array

**Replaced with:**
- `/api/whoami` returns `roles: string[]` (already present) and
  `isManager: boolean` (new field, derived from roster manager map)
- Frontend `useAuth` exports `roles` (already present) and `hasRole(role)`

**Migration for consumers of `permissionTier`:**

| Old pattern | New pattern |
|-------------|-------------|
| `req.permissionTier === 'admin'` | `req.isAdmin` |
| `req.permissionTier === 'team-admin'` | `req.isTeamAdmin` |
| `req.permissionTier === 'release-manager'` | `roleStore.hasRole(email, 'release-manager')` |
| `req.permissionTier === 'manager'` | `req.isManager` (new boolean, from roster) |
| `req.permissionTier === 'user'` | `!req.isAdmin && !req.isTeamAdmin && !req.isManager` |
| `permissionTier.value` (frontend) | `roles.value` + `isManager.value` |

#### E.1 Specific `permissionTier` Locations in `modules/team-tracker/server/index.js`

Six distinct locations require changes, each with a different replacement
pattern:

1. **Line ~522 (`/permissions/me` response):**
   ```js
   // Before: tier: req.permissionTier
   // After:  roles: req.userRoles, isManager: req.isManager
   ```
   This is a **data contract change** for the `/permissions/me` endpoint.
   The response shape changes from `{ email, uid, tier, managedUids, roles }`
   to `{ email, uid, roles, isManager, managedUids }`.

2. **Line ~686 (field-completeness admin endpoint inline auth check):**
   ```js
   // Before: req.permissionTier !== 'admin' && req.permissionTier !== 'team-admin'
   // After:  !req.isAdmin && !req.isTeamAdmin
   ```

3. **Line ~1930 (audit log access gate):**
   ```js
   // Before: req.permissionTier === 'user'
   // After:  !req.isAdmin && !req.isTeamAdmin && !req.isManager
   ```

4. **Line ~2834 (roster API `permissions` object -- data contract change):**
   ```js
   // Before: permissions: { tier: req.permissionTier, uid, managedUids }
   // After:  permissions: { roles: req.userRoles, isManager: req.isManager, uid, managedUids }
   ```
   The frontend `usePermissions` composable consumes this response (see
   section K).

5. **Line ~4309 (field-completeness message provider early bailout):**
   ```js
   // Before: if (user.permissionTier === 'user') return [];
   // After:  if (!user.isAdmin && !user.isTeamAdmin && !user.isManager) return [];
   ```

6. **Line ~4375 (field-completeness message provider admin link routing):**
   ```js
   // Before: const isAdminLike = user.permissionTier === 'admin' || user.permissionTier === 'team-admin'
   // After:  const isAdminLike = user.isAdmin || user.isTeamAdmin
   ```

#### E.2 Message Provider `userContext` (CRITICAL)

`server/dev-server.js` line ~393-398 constructs `userContext` for message
providers:

```js
// Before:
const userContext = {
  email: req.userEmail,
  uid: req.userUid,
  isAdmin: req.isAdmin,
  isTeamAdmin: req.isTeamAdmin,
  permissionTier: req.permissionTier
};

// After:
const userContext = {
  email: req.userEmail,
  uid: req.userUid,
  isAdmin: req.isAdmin,
  isTeamAdmin: req.isTeamAdmin,
  isManager: req.isManager,
  roles: req.userRoles
};
```

If this is not updated, `user.permissionTier` in the field-completeness
provider (locations 5 and 6 above) would be `undefined`, causing:
- **Correctness bug:** The early bailout at line ~4309 would fail
  (`undefined === 'user'` is false), meaning regular users would NOT bail
  out early and would receive manager notifications they should not see.
- **Performance regression:** All users would trigger the expensive
  manager-hierarchy disk I/O instead of only managers/admins.

### F. `req` Property Cleanup

**Kept:**
- `req.isAdmin` -- fundamental platform concept
- `req.userEmail`, `req.userUid` -- identity

**Added:**
- `req.isManager` -- boolean, true if user has direct reports in registry
- `req.userRoles` -- full roles array from role store

**Kept as derived aliases** (computed from `req.userRoles`, NOT separate
role store calls):
- `req.isTeamAdmin` -- set as `req.userRoles.includes('team-admin')`.
  18 occurrences across 5 files reference this; keeping it as a derived
  alias limits blast radius. Can be removed in a follow-up.
- `req.isReleaseManager` -- set as
  `req.userRoles.includes('release-manager')`. Same rationale.

```js
req.userRoles = roleStore.getRoles(req.userEmail);
req.isTeamAdmin = req.userRoles.includes('team-admin');
req.isReleaseManager = req.userRoles.includes('release-manager');
req.isManager = isManager(req.userUid, registry);
```

**Removed:**
- `req.permissionTier` -- removed entirely

### G. Token Scope Validation

`server/api-tokens.js` changes:

1. Remove `VALID_SCOPES` constant
2. `validateScopes()` accepts the scope registry as a parameter (or reads from
   a module-level reference set at init time)
3. `init()` accepts `{ storageModule, scopeRegistry }` instead of just
   `storageModule`
4. Validation calls `scopeRegistry.isValid(scope)` instead of
   `VALID_SCOPES.includes(scope)`

The existing `SCOPE_MIGRATION_MAP` for old release module scopes stays
unchanged (it maps retired scope names to current ones).

#### G.1 Scope Validation for Existing Tokens (Edge Case)

`validateScopes()` is called in two contexts:
1. **Token creation** -- new scopes must be valid in the registry
2. **Scope update** (`updateTokenScopes`) -- new scopes must be valid

Tokens that were created before this change may have scopes from modules
that are now disabled (and thus not registered). Two scenarios:

**Reading existing tokens:** `validateToken()` does NOT call
`validateScopes()` -- it returns the token record as-is. Unrecognized scopes
in existing tokens are silently ignored at runtime (they grant no access
since no route checks for them). No change needed here.

**Updating existing tokens:** If an admin tries to update scopes on a token
that includes scopes from a disabled module, `validateScopes()` would reject
them. To handle this, `validateScopes()` should only validate scopes that
are being *added*. Implementation: the update endpoint sends the full
desired scope set. `validateScopes()` checks each scope against the
registry. For backward compatibility, add an `allowUnregistered` option
that silently drops unrecognized scopes rather than throwing:

```js
function validateScopes(scopes, { strict = true } = {}) {
  // ... existing null/array checks ...
  const invalid = scopes.filter(s => !scopeRegistry.isValid(s));
  if (strict && invalid.length > 0) {
    throw new Error(`Invalid scopes: ${invalid.join(', ')}`);
  }
  // In non-strict mode, filter to only valid scopes
  const valid = strict ? scopes : scopes.filter(s => scopeRegistry.isValid(s));
  return [...new Set(valid)];
}
```

Token creation uses strict mode (default). Token updates use strict mode
too -- if a user sends scopes from a disabled module, they get a clear
error. This is acceptable because disabled modules are an edge case and
the error message explains which scopes are invalid.

### H. `/api/token-scopes` Endpoint

Currently returns a hardcoded array in `dev-server.js`. Changed to read from
the scope registry:

```js
app.get('/api/token-scopes', function(req, res) {
  const scopes = scopeRegistry.getAll();
  const readOnlyScopes = scopes
    .filter(s => s.key.endsWith(':read'))
    .map(s => s.key);

  res.json({
    scopes: scopes.map(s => ({
      key: s.key,
      label: s.label,
      description: s.description,
      category: s.category
    })),
    presets: [
      {
        key: 'read-only',
        label: 'Read Only',
        description: 'Read access to all data, no mutations',
        scopes: readOnlyScopes
      },
      {
        key: 'full-access',
        label: 'Full Access',
        description: 'All scopes (same as no restrictions)',
        scopes: ['*']
      }
    ]
  });
});
```

The `read-only` preset is computed dynamically from the registry (all scopes
ending with `:read`). The `full-access` preset is always `['*']`. This
matches the current hardcoded presets exactly -- the existing read-only
preset is `['roster:read', 'metrics:read', 'github:read', 'gitlab:read',
'team-tracker:read', 'releases:read', 'ai-impact:read',
'upstream-pulse:read', 'health-metrics:read']`, which is exactly all scopes
ending in `:read`. Module-specific presets are a future enhancement (not
needed for this PR).

### I. `/api/roles/available` Endpoint (New)

New endpoint for the Settings UI to discover available roles. Requires
`@openapi` JSDoc annotation per AGENTS.md hard constraint #6:

```js
/**
 * @openapi
 * /api/roles/available:
 *   get:
 *     tags: [Auth]
 *     summary: Get available role catalog
 *     description: Returns all registered roles (platform + module). Admin only.
 *     responses:
 *       200:
 *         description: Role catalog
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 roles:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       label:
 *                         type: string
 *                       description:
 *                         type: string
 *                       module:
 *                         type: string
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
app.get('/api/roles/available', requireAdmin, function(req, res) {
  res.json({ roles: roleRegistry.getAll() });
});
```

### J. Settings UI (`UserManagement.vue`)

Currently hardcodes role options as `<option>` tags. Changed to:

1. On mount, fetch `GET /api/roles/available`
2. Render role dropdown from the response
3. Role badge colors use a small palette map with a fallback for unknown
   module roles

### K. `usePermissions` Composable and `/permissions/me` Response

The `tier` computed property currently maps from `permissionTier`. The
`/api/modules/team-tracker/permissions/me` endpoint response shape changes:

```js
// Before: { email, uid, tier, managedUids, roles }
// After:  { email, uid, roles, isManager, managedUids }
// "tier" field removed
```

The composable changes to:

```js
// Before:
const tier = computed(() => permissionData.value?.tier || 'user')
const isManager = computed(() => tier.value === 'manager' || tier.value === 'admin')
const isAdmin = computed(() => tier.value === 'admin')
const isTeamAdmin = computed(() => tier.value === 'team-admin' || tier.value === 'admin')

// After:
const roles = computed(() => permissionData.value?.roles || [])
const isManager = computed(() =>
  permissionData.value?.isManager || roles.value.includes('admin')
)
const isAdmin = computed(() => roles.value.includes('admin'))
const isTeamAdmin = computed(() =>
  roles.value.includes('admin') || roles.value.includes('team-admin')
)
```

#### K.1 `isManager` Semantics -- Admins Retain Manager Status (CRITICAL)

The old code: `const isManager = computed(() => tier.value === 'manager' || tier.value === 'admin')` -- admins are always considered managers.

If we naively replace this with `permissionData.value?.isManager` (purely
from roster hierarchy), an admin with NO direct reports would lose
`isManager === true`. This would break:
- `canEdit(uid)` -- falls through to `managedUids.has(uid)`, which is empty
  for non-manager admins (but `isAdmin` check above catches this -- OK)
- UI gates like `UnassignedPeople.vue` that check `isManager` to show
  assignment controls

**Decision:** Preserve the old semantics. On the **backend**,
`req.isManager` reflects pure roster hierarchy (does the user have direct
reports?). On the **frontend**, `usePermissions().isManager` adds the admin
override:

```js
const isManager = computed(() =>
  permissionData.value?.isManager || roles.value.includes('admin')
)
```

This ensures admins always have manager-level UI access even without direct
reports, matching current behavior. The `canEdit()` function already checks
`isAdmin` first, so the backend `req.isManager` being false for admin
non-managers does not affect authorization.

### L. `PermissionBadge.vue` Changes

This component destructures `tier` from `usePermissions()` and will break
when `tier` is removed. Update to use `roles` and `isManager`:

```vue
<script setup>
import { usePermissions } from '@shared/client/composables/usePermissions'

const { roles, isAdmin, isTeamAdmin, isManager, loading } = usePermissions()

const badgeConfig = computed(() => {
  if (isAdmin.value) return { label: 'Admin', classes: 'bg-red-100 text-red-800' }
  if (isTeamAdmin.value) return { label: 'Team Admin', classes: 'bg-orange-100 text-orange-800' }
  if (isManager.value) return { label: 'Manager', classes: 'bg-blue-100 text-blue-800' }
  return { label: 'Viewer', classes: 'bg-gray-100 text-gray-700' }
})
</script>
```

### M. Module-Internal Middleware (Unchanged)

Per the user's decision, these stay inside their respective modules:

- **team-tracker**: `requireTeamPurview`, `requireManagerOrAdmin` --
  data-driven authorization based on roster manager hierarchy
- **health-metrics**: `requireMetricsViewer` -- checks
  `roleStore.hasRole(email, 'usage-metrics-viewer')`

These are not platform concerns. They use `roleStore` from context and make
module-specific authorization decisions. If another module needs similar
manager-hierarchy checks in the future, we could extract a
`requireManagerOf(getTargetUid)` factory into shared. For now, they stay
module-internal. This is noted as a revisitable decision.

### N. Health Metrics `permissionTier` in Events

`server/health-metrics/routes.js` records `permissionTier` in analytics
events. This changes to record the roles array:

```js
// Before:
permissionTier: req.permissionTier || 'user',

// After:
roles: req.userRoles || [],
```

#### N.1 Aggregator Backward Compatibility

The aggregator (`server/health-metrics/aggregator.js`) currently groups by
single-value `byPermissionTier`. The new `roles` field is an array, which
is fundamentally different -- a user with `['admin', 'team-admin']` belongs
to multiple groups.

**Approach:** The aggregator handles both old and new event formats:

```js
// Old events: { permissionTier: 'manager' }
//   -> increment byPermissionTier['manager']
//
// New events: { roles: ['admin', 'team-admin'] }
//   -> increment byRole['admin'] AND byRole['team-admin']
//   -> For empty roles array, increment byRole['user'] (no special roles)

if (event.permissionTier) {
  // Legacy event format
  const pt = event.permissionTier;
  p.byPermissionTier[pt] = (p.byPermissionTier[pt] || 0) + 1;
} else if (event.roles) {
  // New event format
  const roles = event.roles.length > 0 ? event.roles : ['user'];
  for (const role of roles) {
    p.byRole = p.byRole || {};
    p.byRole[role] = (p.byRole[role] || 0) + 1;
  }
}
```

The aggregated monthly files retain the existing `byPermissionTier` key for
historical data. New events populate a new `byRole` key. The health metrics
dashboard UI (if it displays this breakdown) needs to handle both keys.

### O. Releases Module `requireReleaseManager` Distribution

The releases module has a multi-level distribution chain for
`requireReleaseManager` that must be traced carefully:

1. **`modules/releases/server/index.js` (line ~112):** Destructures
   `requireReleaseManager` from `context`. Passes it down to 4 sub-router
   registration calls:
   - `registerRegistryRoutes(router, { ..., requireReleaseManager })` (line ~126)
   - Planning sub-router context `{ ..., requireReleaseManager }` (line ~134)
   - Execution sub-router (via `registerFeatureTrackingRoutes`) `{ ..., requireReleaseManager }` (line ~153)
   - Delivery sub-router `{ ..., requireReleaseManager }` (line ~175)

2. **`modules/releases/server/planning/routes.js` (line ~46):** Destructures
   `requireReleaseManager` from its context. Uses it directly on 6+ routes.
   Also passes it as `requirePM` to health routes (line ~233):
   ```js
   healthRoutes(router, { ..., requirePM: requireReleaseManager })
   ```

3. **`modules/releases/server/planning/health/health-routes.js` (line ~71):**
   Destructures `requirePM` from its context. Uses it on 7 routes
   (override PUT/DELETE, snapshot POST, refresh POST, config PUT, jira-fields
   GET, rice-test POST).

4. **`modules/releases/server/hygiene/routes.js` (line ~125):** Destructures
   `requireReleaseManager` from context. Uses it on 4 routes (refresh POST,
   refresh-all POST, config GET/POST).

5. **`modules/releases/server/registry.js`:** Destructures
   `requireReleaseManager` from its context.

**Migration:** In `modules/releases/server/index.js`, replace:
```js
// Before:
const { ..., requireReleaseManager, ... } = context;

// After:
const { ..., requireRole, ... } = context;
const requireReleaseManager = requireRole('release-manager');
```

The local `requireReleaseManager` constant is created once and passed down
to all sub-routers unchanged. This means sub-router files
(`planning/routes.js`, `hygiene/routes.js`, `registry.js`) do NOT need
changes -- they continue to destructure `requireReleaseManager` from their
local context object, which now holds the `requireRole('release-manager')`
result. The `requirePM` alias in `health-routes.js` also remains unchanged.

---

## File-by-File Change List

### New Files

| File | Description |
|------|-------------|
| `shared/server/role-registry.js` | `createRoleRegistry()` -- role registration and lookup |
| `shared/server/scope-registry.js` | `createScopeRegistry()` -- scope registration and lookup |
| `shared/server/__tests__/role-registry.test.js` | Unit tests for role registry |
| `shared/server/__tests__/scope-registry.test.js` | Unit tests for scope registry |

### Modified Files

| File | Changes |
|------|---------|
| `shared/server/role-store.js` | Remove `VALID_ROLES` constant. `assignRole`/`revokeRole` validate via injected `roleRegistry.isValid()` instead of checking against hardcoded list. |
| `shared/server/auth.js` | Remove `requireReleaseManager`. Add `requireRole(role)` factory. Set `req.userRoles`, `req.isManager`. Keep `req.isTeamAdmin` and `req.isReleaseManager` as derived aliases from `req.userRoles`. Remove `req.permissionTier`. |
| `shared/server/permissions.js` | Remove `getPermissionTier()`. Keep `buildManagerMap`, `getManagedUids`, `getDirectReports`, `isManager`, `canEditPerson`. |
| `shared/server/module-context.js` | Add `registerRole`, `registerScopes`, `requireRole` to `CoreServices` and `ModuleContext` typedefs. Remove `requireReleaseManager`. Update `buildModuleContext()` and `createTestContext()`. |
| `server/dev-server.js` | Create registries at startup. Register platform roles/scopes AND health-metrics roles/scopes (see A.1). Pass registries to `buildModuleContext`. Rewrite `/api/whoami` (remove `permissionTier`, add `isManager`). Rewrite `/api/token-scopes` to read from registry. Add `/api/roles/available` with `@openapi` annotation. Update `/api/messages` userContext (remove `permissionTier`, add `roles` + `isManager` -- see E.2). Remove `requireReleaseManager` from `coreServices` object (line ~1284), add `requireRole`. |
| `server/api-tokens.js` | Remove `VALID_SCOPES`. `init()` accepts scope registry. `validateScopes()` delegates to registry. |
| `shared/client/composables/useAuth.js` | Remove `permissionTier` computed. Add `hasRole(role)` helper. Expose `isManager` from whoami response. |
| `shared/client/composables/usePermissions.js` | Replace `tier` with `roles` array. Derive `isAdmin`, `isTeamAdmin`, `isManager` from roles + isManager field. `isManager` preserves admin override (see K.1). Remove `tier` export. |
| `shared/client/components/PermissionBadge.vue` | Replace `tier` destructure with `roles`, `isAdmin`, `isTeamAdmin`, `isManager`. Compute badge from role hierarchy (see section L). |
| `src/components/UserManagement.vue` | Fetch roles from `/api/roles/available`. Dynamic dropdown. Dynamic badge colors. |
| `src/components/App.vue` | Remove `permissionTier` reference in impersonation banner. Use roles array. |
| `modules/releases/server/index.js` | Replace `requireReleaseManager` destructure from `context` with `requireRole`. Create local `const requireReleaseManager = requireRole('release-manager')` and pass to sub-routers as before. Add `context.registerRole('release-manager', {...})` and `context.registerScopes([...])`. |
| `modules/releases/server/registry.js` | No change -- receives `requireReleaseManager` from parent context. |
| `modules/releases/server/planning/routes.js` | No change -- receives `requireReleaseManager` from parent context. |
| `modules/releases/server/planning/health/health-routes.js` | No change -- receives `requirePM` (alias for `requireReleaseManager`) from parent context. |
| `modules/releases/server/hygiene/routes.js` | No change -- receives `requireReleaseManager` from parent context. |
| `modules/team-tracker/server/index.js` | Replace 6 `req.permissionTier` checks (see E.1 for each). Update `/permissions/me` response shape. Update roster API `permissions` object. Update field-completeness provider to use `user.isManager`/`user.isAdmin`/`user.isTeamAdmin`. Add `context.registerScopes([...])`. **Note:** Do NOT touch line ~1264 `const VALID_SCOPES = ['all', 'direct', 'org']` -- this is an unrelated local constant for manager dashboard scope filtering. |
| `modules/team-tracker/server/routes/field-exceptions.js` | Replace `req.permissionTier === 'user'` with `!req.isAdmin && !req.isTeamAdmin && !req.isManager` |
| `modules/ai-impact/server/index.js` | Add `context.registerScopes([...])` |
| `modules/upstream-pulse/server/index.js` | Add `context.registerScopes([...])` |
| `server/health-metrics/routes.js` | Replace `permissionTier` in event tracking with `roles: req.userRoles`. `requireMetricsViewer` stays as-is (uses `roleStore.hasRole`). |
| `server/health-metrics/aggregator.js` | Handle both old `permissionTier` (string) and new `roles` (array) in aggregation. New events populate `byRole` key. See N.1. |

### Documentation Files

| File | Changes |
|------|---------|
| `docs/MODULES.md` | Update context properties table: remove `requireReleaseManager`, add `requireRole(role)`, `registerRole(id, config)`, `registerScopes(configs)`. Update message provider user context shape (line ~425): replace `permissionTier` with `roles`, `isManager`, `isAdmin`, `isTeamAdmin`. Update early bailout guidance (line ~460): replace `user.permissionTier` example. |
| `docs/DATA-FORMATS.md` | Update health metrics event schema (line ~1026): replace `permissionTier` string field with `roles` array field. Note backward compat for old events. |
| `shared/API.md` | Update shared exports (remove `VALID_ROLES`, add registries). |
| `.claude/CLAUDE.md` | Update API routes section (add `/api/roles/available`), remove `permissionTier` references from whoami description. |

### Test Files to Update

| File | Changes |
|------|---------|
| `shared/server/__tests__/role-store.test.js` | Remove `VALID_ROLES` import. Pass role registry to role store for validation. |
| `shared/server/__tests__/auth.test.js` | Remove `requireReleaseManager` tests. Add `requireRole()` tests. Update `req` property assertions (`req.userRoles`, no `req.permissionTier`). |
| `shared/server/__tests__/permissions.test.js` | Remove `getPermissionTier` tests. |
| `shared/server/__tests__/module-context.test.js` | Remove 3 `requireReleaseManager` references (lines ~13, ~32, ~101). Add `requireRole`, `registerRole`, `registerScopes` assertions. |
| `server/__tests__/api-tokens.test.js` | Remove `VALID_SCOPES` tests. Add scope registry integration tests. |
| `server/health-metrics/__tests__/event-store.test.js` | Update event fixtures: replace `permissionTier` with `roles` array in all test events. |
| `modules/releases/__tests__/server/rbac.test.js` | Remove `VALID_ROLES` import (line ~3). Replace "release-manager role in VALID_ROLES" test (lines ~25-27) with role registry validation test. Replace `requireReleaseManager` middleware tests (lines ~79-119) with `requireRole('release-manager')` tests. |
| `modules/releases/__tests__/server/planning/routes.test.js` | Replace `requireReleaseManager` in mock context (line ~149) with `requireRole` function. Update test at line ~190. |
| `modules/releases/__tests__/server/planning/invalidate-cache.test.js` | Replace `requireReleaseManager` in mock contexts (lines ~131, ~273). |
| `modules/releases/__tests__/server/storage-migration.test.js` | Replace `requireReleaseManager` in mock context (line ~62). |
| `modules/team-tracker/__tests__/server/field-completeness-endpoint.test.js` | Replace `permissionTier` in mock req objects with `userRoles` + `isManager`. |
| `modules/team-tracker/__tests__/server/field-completeness-with-exceptions.test.js` | Same. |
| `modules/team-tracker/__tests__/server/field-completeness-provider.test.js` | Replace `user.permissionTier` with `user.roles` / `user.isManager` / `user.isAdmin` / `user.isTeamAdmin`. |
| `modules/team-tracker/__tests__/server/manager-dashboard-endpoint.test.js` | Replace `permissionTier` in mock req. |
| `modules/team-tracker/__tests__/server/field-exceptions-routes.test.js` | Same. |
| `modules/upstream-pulse/__tests__/server/index.test.js` | Add `registerScopes` to mock context. |

**Note:** `shared/server/__tests__/auth-tokens.test.js` does not reference
any of the changed concepts (`VALID_SCOPES`, `permissionTier`,
`requireReleaseManager`) and does not need changes.

---

## Startup Sequence

The order matters because modules register roles/scopes during their server
entry function, and the role store needs the registry for validation.

```
1. Create roleRegistry + scopeRegistry
2. Register platform roles (admin, team-admin)
3. Register platform scopes (roster:*, metrics:*, github:*, gitlab:*, admin:manage, tokens:manage)
4. Register health-metrics role (usage-metrics-viewer) + scopes (health-metrics:*)
   directly on registries (health-metrics is NOT a module -- see A.1)
5. Create roleStore with roleRegistry (for validation)
6. Create authMiddleware with roleStore + requireRole factory
7. Init apiTokens with scopeRegistry
8. Seed roles
9. Mount auth middleware
10. Load modules -- each module calls:
    - context.registerRole()    -- adds module roles to registry
    - context.registerScopes()  -- adds module scopes to registry
    - Sets up routes using context.requireRole()
11. Mount health-metrics router (receives coreServices, not ModuleContext)
12. /api/token-scopes and /api/roles/available read from registries (live)
```

**Key timing detail:** Modules register roles during `createModuleRouters()`,
which runs at startup before any HTTP requests. By the time the first request
arrives, all roles and scopes are registered. The `/api/token-scopes` and
`/api/roles/available` endpoints read from the live registries, so they always
reflect the current set.

---

## Decision Points

### Kept as module-internal (per user decision, noted as revisitable)

`requireTeamPurview` and `requireManagerOrAdmin` in team-tracker are
data-driven middleware that check the LDAP manager hierarchy. They are
fundamentally different from role-based checks. If another module needs
similar manager-hierarchy checks in the future, we could extract a
`requireManagerOf(getTargetUid)` factory into shared. For now, they stay
module-internal.

### `req.isTeamAdmin` / `req.isReleaseManager` kept as derived aliases

These are computed from `req.userRoles` (not separate role store calls) and
kept as convenience aliases to limit blast radius. They can be removed in a
follow-up cleanup.

### Health metrics historical data

Existing analytics events use `permissionTier` as a string field. New events
use `roles` (array). The aggregator handles both formats -- old events
populate `byPermissionTier`, new events populate `byRole`. Both keys coexist
in aggregated monthly files. See section N.1 for the mapping approach.

### `isManager` frontend semantics

Frontend `usePermissions().isManager` includes admin override
(`isManager || isAdmin`) to preserve existing behavior. Backend
`req.isManager` reflects pure roster hierarchy. See K.1 for rationale.

---

## Deployment Considerations

### Local dev

No special steps. `npm run dev:full` works as before. The only visible
change is that `/api/whoami` no longer returns `permissionTier`.

### Preprod / Prod (OpenShift)

This is a backend + frontend change. Both images must be deployed
simultaneously because:

1. The frontend removes `permissionTier` consumption
2. The backend removes `permissionTier` from API responses
3. The frontend adds `hasRole()` and uses `roles` array
4. The frontend fetches `/api/roles/available` for Settings

**Deployment order:** Build and push both images in the same CI run (the
existing `build-images.yml` workflow handles this). The auto-generated
image tag PR updates both image refs atomically.

**Partial image update risk:** The `build-images.yml` workflow's
`update-prod-image` job runs with `if: always()` and can succeed if only one
of the two builds completes. If the backend build fails but the frontend
build succeeds (or vice versa), a partial image tag update PR could be
created. This is an existing risk in the CI pipeline, not introduced by this
change. Mitigation: the PR reviewer should verify both image tags are updated
before merging. A follow-up improvement could add a check that both builds
succeeded before creating the PR.

### Rollback

If issues arise, revert the image tag PR. Both images roll back to
pre-change versions. The `data/roles.json` format is unchanged, so no
data migration is needed.

### `data/roles.json` format

No changes. The file stores `{ version: 1, assignments: { email: { roles: [...], assignedBy, assignedAt } } }`. The roles array contains role IDs
that are now validated against the registry instead of `VALID_ROLES`. Existing
assignments remain valid as long as the corresponding modules are enabled.

---

## Testing Plan

### Unit tests (Vitest)

1. **role-registry.test.js** -- register, duplicate detection, getAll, isValid
2. **scope-registry.test.js** -- register, duplicate detection, getAll,
   getValidKeys, isValid
3. **role-store.test.js** -- updated to use registry for validation
4. **auth.test.js** -- `requireRole()` factory, `req.userRoles`,
   `req.isManager`, removal of `requireReleaseManager`
5. **permissions.test.js** -- removal of `getPermissionTier` tests
6. **api-tokens.test.js** -- scope validation via registry
7. **module-context.test.js** -- `registerRole`, `registerScopes`,
   `requireRole` in context
8. **releases rbac.test.js** -- updated to use registry and `requireRole`

### Smoke tests (Playwright containers)

The existing smoke tests verify app loads and basic navigation. However,
the frontend uses optional chaining on auth data (e.g.,
`user.value?.permissionTier`), so a missed frontend update would silently
degrade (show undefined) rather than crash. Smoke tests would still pass.
**Unit tests and manual verification are the actual safety nets** for
catching permission-related regressions, not smoke tests.

### Integration tests

No new integration tests needed. Existing module integration tests cover
role-gated routes (they use demo mode which bypasses auth).

### Manual verification

- [ ] Settings > Users: role dropdown shows all roles including module roles
- [ ] Assign/revoke `release-manager` role works
- [ ] `/api/whoami` returns `roles` array, no `permissionTier`
- [ ] `/api/token-scopes` returns all scopes including module scopes
- [ ] Token creation with module scopes works
- [ ] Token scope update with scopes from disabled module shows clear error
- [ ] Impersonation still works (uses `req.userRoles` internally)
- [ ] Releases module routes still enforce release-manager check
- [ ] Health metrics viewer access still works
- [ ] `/api/messages` returns correct notifications for regular users
  (no false manager notifications)
- [ ] PermissionBadge shows correct label for admin/manager/viewer
- [ ] Field-completeness audit endpoint rejects non-admin/team-admin users
