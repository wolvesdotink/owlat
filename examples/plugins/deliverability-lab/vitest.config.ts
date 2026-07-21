import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
	},
	resolve: {
		alias: {
			'@owlat/plugin-kit': resolve(__dirname, '../../../packages/plugin-kit/src/index.ts'),
		},
	},
});
