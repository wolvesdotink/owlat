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
			// index.ts is the poll-loop entry-point; convexClient.ts / github.ts are
			// thin SDK adapters. The shell-injection-safe argv builders in
			// taskRunner.ts are the security-critical logic under test.
			exclude: ['src/**/__tests__/**', 'src/index.ts'],
			thresholds: {
				lines: 20,
			},
		},
	},
});
