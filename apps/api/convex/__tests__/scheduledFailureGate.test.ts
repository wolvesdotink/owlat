import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createFunctionHandle } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import { scheduledFailureSeam } from './helpers/scheduledFailureSeam';
import { expectScheduledFailure, takeScheduledFailures } from './helpers/scheduledFailures';
import {
	runThrowingScheduledFunction,
	SCHEDULED_SENTINEL_SWITCH,
	THROWING_FUNCTION,
} from './helpers/scheduledFailureSentinel';
import { newHarness } from './testModules';

/**
 * convex-test catches a throwing scheduled function and only logs it, so a
 * broken scheduled effect used to leave the suite green. `vitest.setup.ts`
 * installs a gate that turns that failure into a failure of the test that
 * scheduled it (or of the file, see `helpers/scheduledFailures.ts`), and the
 * Vite plugin in `helpers/scheduledFailureSeam.ts` reports it to the gate
 * through a channel a mocked `console.error` cannot hide.
 */

const apiRoot = resolve(import.meta.dirname, '..', '..');
const vitestBin = resolve(
	dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
	'vitest.mjs'
);

/** The switch-gated sentinel files the child run executes. */
const SENTINEL_FILES = {
	perTest: 'convex/__tests__/scheduledFailureSentinel.test.ts',
	fileLevel: 'convex/__tests__/scheduledFailureFileSentinel.test.ts',
	excusedLeak: 'convex/__tests__/scheduledFailureExcusedLeakSentinel.test.ts',
} as const;

interface SentinelFileResult {
	name: string;
	status: string;
	message: string;
	assertionResults: { title: string; status: string; failureMessages: string[] }[];
}

function childEnv(): NodeJS.ProcessEnv {
	// The parent worker's VITEST_* markers would make the child believe it is
	// already inside a vitest worker.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST'))
	);
	delete env['FORCE_COLOR'];
	return { ...env, NO_COLOR: '1', [SCHEDULED_SENTINEL_SWITCH]: '1' };
}

describe('scheduled failure gate', () => {
	it('records a scheduled function that throws', async () => {
		await runThrowingScheduledFunction(newHarness());

		// Taking the record clears it, so this test itself still passes.
		const failures = takeScheduledFailures();
		expect(failures.map((failure) => failure.name)).toEqual([THROWING_FUNCTION]);
		expect(String(failures[0]?.error)).toContain('unexpected');
	});

	it('lets a test excuse the one function it sets out to break', async () => {
		expectScheduledFailure(THROWING_FUNCTION);

		await runThrowingScheduledFunction(newHarness());

		expect(takeScheduledFailures()).toEqual([]);
	});

	it('does not excuse a different function', async () => {
		expectScheduledFailure('webhooks/delivery:deliverWebhookInternal');

		await runThrowingScheduledFunction(newHarness());

		expect(takeScheduledFailures().map((failure) => failure.name)).toEqual([THROWING_FUNCTION]);
	});

	describe('while console.error is mocked', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('still records the failure, and the log line still reaches the mock', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			await runThrowingScheduledFunction(newHarness());

			expect(takeScheduledFailures().map((failure) => failure.name)).toEqual([THROWING_FUNCTION]);
			expect(consoleError).toHaveBeenCalledWith(
				`Error when running scheduled function ${THROWING_FUNCTION}`,
				expect.anything()
			);
		});

		it('still honours the opt-out', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			expectScheduledFailure(THROWING_FUNCTION);

			await runThrowingScheduledFunction(newHarness());

			expect(takeScheduledFailures()).toEqual([]);
		});

		it('still records after a mock was replaced by an assignment', async () => {
			const original = console.error;
			console.error = () => {};
			try {
				await runThrowingScheduledFunction(newHarness());
			} finally {
				console.error = original;
			}

			expect(takeScheduledFailures().map((failure) => failure.name)).toEqual([THROWING_FUNCTION]);
		});
	});

	it('names a job scheduled through a function handle by its path', async () => {
		const t = newHarness();
		await t.run(async (ctx) => {
			const handle = await createFunctionHandle(
				internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries
			);
			await ctx.scheduler.runAfter(0, handle, { unexpected: true } as never);
		});
		await t.finishAllScheduledFunctions(() => {});

		expect(takeScheduledFailures().map((failure) => failure.name)).toEqual([THROWING_FUNCTION]);
	});

	describe('the convex-test seam', () => {
		const seam = scheduledFailureSeam();
		const entry = '/repo/node_modules/convex-test/dist/index.js';
		const reportLine = 'console.error(`Error when running scheduled function ${name}`, error);';
		const scheduleLine = 'scheduler.timerScheduled();';
		const convexTestShape = [
			'const requestMetadataStorage = new AsyncLocalStorage();',
			'const globalOverridesStorage = new AsyncLocalStorage();',
			`function schedule() { ${scheduleLine} }`,
			`try { run(); } catch (error) { ${reportLine} }`,
		].join('\n');

		it('leaves every other module alone', () => {
			expect(seam.transform('console.error(`x`, error);', '/repo/convex/foo.ts')).toBeNull();
		});

		it('refuses a convex-test build it does not recognise', () => {
			expect(() => seam.transform('export const changed = true;', entry)).toThrow(
				/convex-test changed/
			);
			for (const missing of [reportLine, scheduleLine, 'const globalOverridesStorage = ']) {
				expect(() => seam.transform(convexTestShape.replace(missing, ''), entry)).toThrow(
					/convex-test changed/
				);
			}
		});

		it('reports to the sink before logging, and each scheduled job before arming it', () => {
			const out = seam.transform(convexTestShape, entry)!;
			const failureSink = out.indexOf('owlat.test.scheduledFailureSink');
			const jobSink = out.indexOf('owlat.test.scheduledJobSink');
			expect(failureSink).toBeGreaterThan(-1);
			expect(failureSink).toBeLessThan(out.indexOf(reportLine));
			expect(jobSink).toBeGreaterThan(-1);
			expect(jobSink).toBeLessThan(out.indexOf(scheduleLine));
		});
	});

	it('fails the tests and files it must, and only those', () => {
		const report = resolve(tmpdir(), `owlat-scheduled-sentinel-${process.pid}-${Date.now()}.json`);
		let exitStatus: number | null;
		let files: SentinelFileResult[];
		try {
			exitStatus = spawnSync(
				process.execPath,
				[
					vitestBin,
					'run',
					'--project',
					'unit',
					'--reporter',
					'json',
					'--outputFile',
					report,
					...Object.values(SENTINEL_FILES),
				],
				{ cwd: apiRoot, env: childEnv(), encoding: 'utf8', timeout: 120_000 }
			).status;
			files = (JSON.parse(readFileSync(report, 'utf8')) as { testResults: SentinelFileResult[] })
				.testResults;
		} finally {
			rmSync(report, { force: true });
		}
		const file = (key: keyof typeof SENTINEL_FILES) => {
			const found = files.find((entry) => entry.name.endsWith(SENTINEL_FILES[key]));
			if (!found) throw new Error(`no result for ${SENTINEL_FILES[key]}`);
			return {
				status: found.status,
				// CI forces colour; the assertions read plain text.
				message: stripVTControlCharacters(found.message),
				tests: Object.fromEntries(
					found.assertionResults.map((test) => [test.title.split(':')[0], test.status])
				),
				failures: stripVTControlCharacters(
					found.assertionResults.flatMap((test) => test.failureMessages).join('\n')
				),
			};
		};

		// A test whose own assertions pass fails when its scheduled function
		// throws, also with console.error mocked.
		const perTest = file('perTest');
		expect(Object.values(perTest.tests)).toEqual(['failed', 'failed']);
		expect(perTest.failures).toContain('scheduled function(s) threw during this test');
		expect(perTest.failures).toContain(THROWING_FUNCTION);

		// Every test passes and the file still fails: the retry hid nothing, the
		// leak failed no innocent test, and the job the last test left behind
		// was seen before the file ended.
		const fileLevel = file('fileLevel');
		expect(fileLevel.tests).toEqual({
			flaky: 'passed',
			leaky: 'passed',
			innocent: 'passed',
			last: 'passed',
		});
		expect(fileLevel.status).toBe('failed');
		expect(fileLevel.message).toContain('3 scheduled function(s) threw in this file');
		expect(fileLevel.message).toMatch(/scheduled by "flaky: [^"]*", ran during "flaky: /);
		expect(fileLevel.message).toMatch(/scheduled by "leaky: [^"]*", ran during "innocent: /);
		expect(fileLevel.message).toMatch(/scheduled by "last: [^"]*", ran outside any test/);

		// A leak its own test excused fails nothing.
		const excused = file('excusedLeak');
		expect(excused.status).toBe('passed');
		expect(Object.values(excused.tests)).toEqual(['passed', 'passed']);

		expect(exitStatus).toBe(1);
	}, 150_000);
});
