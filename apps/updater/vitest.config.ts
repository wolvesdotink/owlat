import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: {
		lines: 80,
		// index.ts is the HTTP server entry-point (boots a listener on import);
		// its pure policy lives in security.ts, which is what we cover.
		exclude: ['src/index.ts'],
	},
});
