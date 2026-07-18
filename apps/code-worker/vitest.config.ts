import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// The worker consumes plugin-kit's packaged dist in production; tests run from
	// a frozen clean checkout, so resolve the workspace package to source (same
	// source alias apps/api uses) to avoid a build step before the suite.
	resolve: {
		alias: {
			'@owlat/plugin-kit': resolve(__dirname, '../../packages/plugin-kit/src/index.ts'),
		},
	},
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
