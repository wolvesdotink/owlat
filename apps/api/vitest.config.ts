import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';
import { scheduledFailureSeam } from './convex/__tests__/helpers/scheduledFailureSeam';
import { creationTimeSeam } from './convex/__tests__/helpers/creationTimeSeam';
import { storageStoreSeam } from './convex/__tests__/helpers/storageStoreSeam';
import { PARALLEL_GATE_TIMEOUT_MS, POPULATION_SUITE_TIMEOUT_MS } from '../../vitest.timeouts';

const unitTestPattern = 'convex/**/__tests__/**/*.test.ts';
const integrationTestPattern = 'convex/**/__tests__/**/*.integration.test.ts';

/**
 * The suites that drive a population past a production limit to its end (see
 * POPULATION_SUITE_TIMEOUT_MS): a reminder drain over the send cap, held-question
 * pages at the read limits, a remote-op queue longer than a deferral pass, sender
 * undos over the transaction limits, an audience scan past its read budget.
 * They run in their own projects, with that budget, in the environment their
 * file name picks; everything else keeps the parallel-gate budget.
 */
const populationSuites = [
	'convex/__tests__/clarificationHoldBounds.integration.test.ts',
	'convex/__tests__/clarificationReminderLimits.integration.test.ts',
	'convex/__tests__/preflightBindingPopulations.test.ts',
	'convex/mail/__tests__/remoteOpOrder.test.ts',
	'convex/mail/arrival/__tests__/transactionLimits.test.ts',
];
const isIntegrationSuite = (path: string) => path.endsWith('.integration.test.ts');
const populationBudget = {
	testTimeout: POPULATION_SUITE_TIMEOUT_MS,
	hookTimeout: POPULATION_SUITE_TIMEOUT_MS,
};

export default defineConfig({
	// Lets the scheduled-failure gate (vitest.setup.ts) see a throwing scheduled
	// function even while a test has console.error mocked, and lets a test give
	// documents one shared `_creationTime` (helpers/creationTimeSeam.ts), and
	// keeps parallel blob stores in one action from racing convex-test's
	// transaction flag (helpers/storageStoreSeam.ts).
	plugins: [scheduledFailureSeam(), creationTimeSeam(), storageStoreSeam()],
	test: {
		setupFiles: ['./vitest.setup.ts'],
		server: { deps: { inline: ['convex-test'] } },
		// Every test builds a convex-test harness whose module graph its worker
		// imports lazily: the HTTP router's whole `convex/` tree on an integration
		// test's first `t.fetch`, the send worker's graph on a delivery test's
		// first send. A full API run initializes hundreds of those graphs in
		// parallel, and the release gate runs it beside every other workspace, so
		// a test that takes a second alone can take tens of seconds there. That is
		// the fixed cost the shared parallel-gate budget is sized for.
		testTimeout: PARALLEL_GATE_TIMEOUT_MS,
		hookTimeout: PARALLEL_GATE_TIMEOUT_MS,
		// A project per environment and budget. Projects of one group run at the
		// same time, under the run's one worker limit, so each population project
		// joins its environment's group instead of adding a run of its own.
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: [unitTestPattern],
					exclude: ['convex/_generated/**', integrationTestPattern, ...populationSuites],
					environment: 'node',
					sequence: { groupOrder: 0 },
				},
			},
			{
				extends: true,
				test: {
					name: 'unit-population',
					include: populationSuites.filter((path) => !isIntegrationSuite(path)),
					environment: 'node',
					...populationBudget,
					sequence: { groupOrder: 0 },
				},
			},
			{
				extends: true,
				test: {
					name: 'integration',
					include: [integrationTestPattern],
					exclude: ['convex/_generated/**', ...populationSuites],
					environment: 'edge-runtime',
					sequence: { groupOrder: 1 },
				},
			},
			{
				extends: true,
				test: {
					name: 'integration-population',
					include: populationSuites.filter(isIntegrationSuite),
					environment: 'edge-runtime',
					...populationBudget,
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
		coverage: packageCoverage({
			include: ['convex/**/*.ts'],
			exclude: ['convex/_generated/**', 'convex/betterAuth/**'],
			// Ratchet baseline: the suite covers ~69% of lines (3300+ tests). Set a
			// few points below actual so the threshold guards real regressions
			// without flaking on run-to-run async variance. Raise as coverage
			// climbs; never lower it without justification.
			//
			// CI shards this suite ×4. OWLAT_COVERAGE_COLLECT_ONLY drops all
			// floors during shard collection; the identified merge restores and
			// enforces this threshold tree, including any future additional floors.
			lines: 65,
		}),
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
