import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { scheduledFailureSeam } from './convex/__tests__/helpers/scheduledFailureSeam.ts';

const integrationTestPattern = 'convex/**/__tests__/**/*.integration.test.ts';

export default defineConfig({
	// Lets the scheduled-failure gate (vitest.setup.ts) see a throwing scheduled
	// function even while a test has console.error mocked.
	plugins: [scheduledFailureSeam()],
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
		// A retry that passes cannot hide a scheduled function that threw in the
		// attempt before it: the scheduled-failure gate reports it again in
		// `afterAll`, which is not retried (convex/__tests__/helpers/scheduledFailures.ts).
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
		// Unhandled errors fail the run; nothing is filtered. The suite used to set
		// `dangerouslyIgnoreUnhandledErrors` for convex-test's "Write outside of
		// transaction" rejections from `ctx.scheduler.runAfter()`. convex-test now
		// runs each scheduled function in its own transaction, so that message now
		// means a write landed with no transaction open, such as an un-awaited
		// `ctx.db` call finishing after its mutation returned: a real bug. A test
		// whose scheduled work outlives it should drain that work with
		// `t.finishAllScheduledFunctions(...)` before returning, rather than be
		// excused here. `convex/__tests__/unhandledErrorGate.test.ts` checks that
		// a leaked rejection still fails the run.
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
