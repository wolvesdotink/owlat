import { describe, expect, it } from 'vitest';
import { SENTINEL_MESSAGE, SENTINEL_SWITCH } from './helpers/unhandledErrorSentinel';

/**
 * A test that passes its assertion while leaking a rejected promise nobody
 * awaits. It is skipped in every normal run; `unhandledErrorGate.test.ts`
 * spawns vitest on this file with the switch below set and asserts that the
 * leak alone turns the run red.
 */
describe.skipIf(process.env[SENTINEL_SWITCH] !== '1')('unhandled error sentinel', () => {
	it('passes while a floating promise rejects in the background', async () => {
		void Promise.reject(new Error(SENTINEL_MESSAGE));
		// Give the rejection a turn to surface while the test is still running,
		// so the run attributes it to this file.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(true).toBe(true);
	});
});
