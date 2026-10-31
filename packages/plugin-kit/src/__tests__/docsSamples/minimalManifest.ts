// #region minimal-manifest
import { definePlugin } from '@owlat/plugin-kit';

export const helloPlugin = definePlugin({
	id: 'hello-owlat',
	version: '0.1.0',
	capabilities: ['plugin-storage:read', 'plugin-storage:write'],
	// Storage capabilities REQUIRE a flag: access must be revocable at runtime.
	flag: { default: false },
});
// #endregion minimal-manifest
