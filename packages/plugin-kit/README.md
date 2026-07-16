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

Bundled agent steps are data-only manifest contributions. They require an
explicit feature flag and the `agent:step` capability; executable code remains
behind one condition-independent package export:

```ts
const manifest = definePlugin({
	id: 'policy-pack',
	version: '1.0.0',
	capabilities: ['agent:step'],
	flag: { default: false, requiredEnvVars: ['POLICY_KEY'] },
	contributes: {
		agentSteps: [
			{
				id: 'spam-score',
				after: 'security_scan',
				module: { exportPath: './agent/spam-score' },
				lifecycleEdges: [{ kind: 'caution', from: 'classifying', to: 'archived' }],
			},
		],
	},
});
```

The host namespaces the stored kind as `plugin.<pluginId>.<localId>`, preserves
the core continuation, and accepts only `continue` or a declared restrict-only
`caution` result. A `draft_review` edge is valid only after the core draft has
persisted a draft. Plugin modules receive a bounded message projection, never a
raw Convex context, and cannot choose the next step, approve, send, or redefine
the core lifecycle graph.

The hosted input projection is truncated by Unicode code points: `from` 512,
`to` 2,048, `subject` 1,024, and each decrypted body 65,536. A plugin's output
and caution reason are validated at the boundary but never stored or returned;
action history contains only a fixed host-owned result and target summary.

Host-mediated storage methods never accept an organization or plugin id. A
host-created service is already bound to both scopes. Plugins must declare and
be granted `plugin-storage:read` for `get`/`list` and
`plugin-storage:write` for `set`/`delete`; disabling or removing a plugin
revokes access immediately. A manifest requesting either storage capability
must declare an explicit `flag`; this keeps storage enablement and revocation
defined while leaving `flag` optional for plugins that request no storage.

The package follows the Owlat repository version while both remain pre-1.0. Its
major version is the compatibility line for public plugin contracts.
