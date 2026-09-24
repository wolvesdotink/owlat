import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
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
 * installs a gate that turns that log line into a test failure.
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

	it('fails a test whose own assertions pass', () => {
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

		expect(output).toMatch(/Tests\s+1 failed/);
		expect(output).toContain(`scheduled function(s) threw during this test`);
		expect(output).toContain(THROWING_FUNCTION);
		expect(result.status).toBe(1);
	}, 150_000);
});
