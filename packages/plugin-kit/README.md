# `@owlat/plugin-kit`

Public TypeScript contracts for building Owlat plugins.

```ts
import { definePlugin } from '@owlat/plugin-kit';

export default definePlugin({
	id: 'example-plugin',
	version: '0.1.0',
	capabilities: ['mail:read'],
});
```

Plugins declare their requested capabilities and contributions in one validated
manifest. Runtime authority is granted separately by the Owlat host. Plugin
handlers receive host-mediated services instead of raw Convex or framework
contexts.

Bundled Convex components are declared as static package exports so Convex can
discover their isolated namespaces at build time:

```ts
const manifest = {
	// ...
	component: { exportPath: './convex/convex.config' },
};
```

Host-mediated storage methods never accept an organization or plugin id. A
host-created service is already bound to both scopes. Plugins must declare and
be granted `plugin-storage:read` for `get`/`list` and
`plugin-storage:write` for `set`/`delete`; disabling or removing a plugin
revokes access immediately. A manifest requesting either storage capability
must declare an explicit `flag`; this keeps storage enablement and revocation
defined while leaving `flag` optional for plugins that request no storage.

The package follows the Owlat repository version while both remain pre-1.0. Its
major version is the compatibility line for public plugin contracts.
