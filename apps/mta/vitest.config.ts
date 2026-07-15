import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['./vitest.setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/__tests__/**', 'src/index.ts', 'src/server.ts'],
			thresholds: {
				lines: 20,
			},
		},
	},
	resolve: {
		alias: {
			'@': resolve(__dirname, 'src'),
		},
	},
});
