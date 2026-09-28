import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';

export default defineConfig({
	test: {
		coverage: packageCoverage({ lines: 92, exclude: ['**/*.d.ts'] }),
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
			'@owlat/provider-kit': resolve(__dirname, '../provider-kit/src/index.ts'),
		},
	},
});
