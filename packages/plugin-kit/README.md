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

The package follows the Owlat repository version while both remain pre-1.0. Its
major version is the compatibility line for public plugin contracts.
