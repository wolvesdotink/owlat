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
		// One event-loop turn: Node reports an unhandled rejection once the
		// microtasks have drained, so it surfaces while this test still runs and
		// the run attributes it to this file.
		await new Promise((resolve) => setImmediate(resolve));
		expect(true).toBe(true);
	});
});
