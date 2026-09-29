import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';

export default defineConfig({
	test: {
		coverage: packageCoverage({ lines: 96, exclude: ['**/*.d.ts'] }),
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
	},
	resolve: {
		alias: {
			'@owlat/plugin-kit': resolve(__dirname, '../plugin-kit/src/index.ts'),
			'@owlat/provider-kit': resolve(__dirname, '../provider-kit/src/index.ts'),
		},
	},
});
