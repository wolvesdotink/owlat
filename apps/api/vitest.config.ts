import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const integrationTestPattern = 'convex/**/__tests__/**/*.integration.test.ts';

export default defineConfig({
	test: {
		setupFiles: ['./vitest.setup.ts'],
		server: { deps: { inline: ['convex-test'] } },
		// Integration tests run the real HTTP-router graph through convex-test, which
		// lazily transforms/imports the whole `convex/` tree on the first `t.fetch`
		// in a worker. That one-time cold-start can exceed a tight timeout for
		// whichever integration test lands first in a contended worker. Keep the
		// tighter default for fast unit tests and give only the integration project
		// enough headroom for that environmental cost.
		testTimeout: 10000,
		hookTimeout: 10000,
		retry: 1,
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['convex/**/__tests__/**/*.test.ts'],
					exclude: ['convex/_generated/**', integrationTestPattern],
					environment: 'node',
					sequence: { groupOrder: 0 },
				},
			},
			{
				extends: true,
				test: {
					name: 'integration',
					include: [integrationTestPattern],
					exclude: ['convex/_generated/**'],
					environment: 'edge-runtime',
					testTimeout: 20000,
					// Splitting by timeout must not create two competing worker pools.
					sequence: { groupOrder: 1 },
				},
			},
		],
		// convex-test produces "Write outside of transaction" unhandled rejections
		// when mutations call ctx.scheduler.runAfter() — this is a known limitation
		dangerouslyIgnoreUnhandledErrors: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['convex/**/*.ts'],
			exclude: ['convex/_generated/**', 'convex/**/__tests__/**', 'convex/betterAuth/**'],
			// Ratchet baseline: the suite covers ~69% of lines (3300+ tests). Set a
			// few points below actual so the threshold guards real regressions
			// without flaking on run-to-run async/retry variance. Raise as coverage
			// climbs; never lower it without justification.
			//
			// CI shards this suite ×3 and disables the gate per shard with
			// --coverage.thresholds.lines=0 (test.yml); the merged report enforces
			// it. If you add another threshold key here (functions, branches, …),
			// the shard jobs will fail spuriously unless it's zeroed there too.
			thresholds: {
				lines: 65,
			},
		},
	},
	resolve: {
		alias: {
			// The host consumes both contract packages from dist in production. Tests
			// run from a frozen clean checkout, so keep the source aliases paired: the
			// plugin-kit entry re-exports the universal provider-kit vocabulary.
			'@owlat/plugin-kit': resolve(__dirname, '../../packages/plugin-kit/src/index.ts'),
			'@owlat/provider-kit': resolve(__dirname, '../../packages/provider-kit/src/index.ts'),
		},
	},
});
