import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['**/__tests__/**', '**/*.d.ts'],
			thresholds: { lines: 96 },
		},
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
