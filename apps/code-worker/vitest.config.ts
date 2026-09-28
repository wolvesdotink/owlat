import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';

export default defineConfig({
	// The worker consumes plugin-kit's packaged dist in production; tests run from
	// a frozen clean checkout, so resolve the workspace package to source (same
	// source alias apps/api uses) to avoid a build step before the suite.
	resolve: {
		alias: {
			'@owlat/plugin-kit': resolve(__dirname, '../../packages/plugin-kit/src/index.ts'),
			'@owlat/provider-kit': resolve(__dirname, '../../packages/provider-kit/src/index.ts'),
		},
	},
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: packageCoverage({
			lines: 75,
			// index.ts is the poll-loop entry-point; convexClient.ts / github.ts are
			// thin SDK adapters. The shell-injection-safe argv builders in
			// taskRunner.ts are the security-critical logic under test.
			exclude: ['src/index.ts'],
		}),
	},
});
