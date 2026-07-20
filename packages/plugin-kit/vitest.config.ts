import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
	},
	resolve: {
		// The docs samples (src/__tests__/docsSamples.test.ts) are quoted verbatim
		// by the docs site, so they must import the PUBLIC specifier a plugin
		// author writes. Point it at the sources so the samples run without a
		// prior `dist` build (tsconfig `paths` does the same for typecheck).
		alias: {
			'@owlat/plugin-kit': resolve(__dirname, 'src/index.ts'),
		},
	},
});
