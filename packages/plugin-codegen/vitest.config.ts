import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
	},
	resolve: {
		alias: {
			'@owlat/plugin-host': resolve(__dirname, '../plugin-host/src/index.ts'),
			'@owlat/plugin-kit': resolve(__dirname, '../plugin-kit/src/index.ts'),
		},
	},
});
