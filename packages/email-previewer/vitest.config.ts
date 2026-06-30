import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			// Vue SFCs are exercised in the host app; the composables hold the
			// compatibility-analysis logic and are what these unit tests cover.
			include: ['src/composables/**/*.ts'],
			exclude: ['src/**/__tests__/**', 'src/**/index.ts'],
			thresholds: {
				lines: 40,
			},
		},
	},
});
