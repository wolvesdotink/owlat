import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: {
		lines: 80,
		// index.ts is the HTTP server entry-point (boots a listener on import);
		// the allowlist policy + the request handler in proxy.ts are what the
		// unit and integration tests cover.
		exclude: ['src/index.ts'],
	},
});
