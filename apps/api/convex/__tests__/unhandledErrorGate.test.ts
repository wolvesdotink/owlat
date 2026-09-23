import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SENTINEL_MESSAGE, SENTINEL_SWITCH } from './helpers/unhandledErrorSentinel';

/**
 * The suite used to run with `dangerouslyIgnoreUnhandledErrors`, so a floating
 * promise that rejected after its test passed never failed anything. This runs
 * the sentinel in a child vitest with the real config and checks that an
 * unhandled rejection unrelated to any assertion still fails the run.
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
	return { ...env, NO_COLOR: '1', [SENTINEL_SWITCH]: '1' };
}

describe('unhandled error gate', () => {
	it('fails the run on an unhandled rejection even when every test passes', () => {
		const result = spawnSync(
			process.execPath,
			[
				vitestBin,
				'run',
				'--project',
				'unit',
				'--reporter',
				'default',
				'convex/__tests__/unhandledErrorSentinel.test.ts',
			],
			{ cwd: apiRoot, env: childEnv(), encoding: 'utf8', timeout: 120_000 }
		);
		// CI forces colour; the assertions read plain text.
		const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);

		expect(output).toMatch(/Tests\s+1 passed/);
		expect(output).toContain('Unhandled Rejection');
		expect(output).toContain(SENTINEL_MESSAGE);
		expect(result.status).toBe(1);
	}, 150_000);
});
