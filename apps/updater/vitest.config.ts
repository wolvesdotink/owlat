import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			// index.ts is the HTTP server entry-point (boots a listener on import);
			// its pure policy lives in security.ts, which is what we cover.
			exclude: ['src/**/__tests__/**', 'src/index.ts'],
			thresholds: {
				lines: 80,
			},
		},
	},
});
