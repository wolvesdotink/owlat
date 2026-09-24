import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
 * installs a gate that turns that failure into a test failure, and the Vite
 * plugin in `helpers/scheduledFailureSeam.ts` reports it to the gate through a
 * channel a mocked `console.error` cannot hide.
 */

const apiRoot = resolve(import.meta.dirname, '..', '..');
const vitestBin = resolve(
	dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
	'vitest.mjs'
);

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

	describe('the convex-test seam', () => {
		const seam = scheduledFailureSeam();
		const entry = '/repo/node_modules/convex-test/dist/index.js';

		it('leaves every other module alone', () => {
			expect(seam.transform('console.error(`x`, error);', '/repo/convex/foo.ts')).toBeNull();
		});

		it('refuses a convex-test build it does not recognise', () => {
			expect(() => seam.transform('export const changed = true;', entry)).toThrow(
				/convex-test changed/
			);
		});

		it('reports to the sink before logging', () => {
			const line = 'console.error(`Error when running scheduled function ${name}`, error);';
			const out = seam.transform(`try { run(); } catch (error) { ${line} }`, entry)!;
			expect(out.indexOf('owlat.test.scheduledFailureSink')).toBeGreaterThan(-1);
			expect(out.indexOf('owlat.test.scheduledFailureSink')).toBeLessThan(out.indexOf(line));
		});
	});

	it('fails a test whose own assertions pass, also with console.error mocked', () => {
		const result = spawnSync(
			process.execPath,
			[
				vitestBin,
				'run',
				'--project',
				'unit',
				'--reporter',
				'default',
				'convex/__tests__/scheduledFailureSentinel.test.ts',
			],
			{ cwd: apiRoot, env: childEnv(), encoding: 'utf8', timeout: 120_000 }
		);
		// CI forces colour; the assertions read plain text.
		const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);

		expect(output).toMatch(/Tests\s+2 failed/);
		expect(output).toContain(`scheduled function(s) threw during this test`);
		expect(output).toContain(THROWING_FUNCTION);
		expect(result.status).toBe(1);
	}, 150_000);
});
