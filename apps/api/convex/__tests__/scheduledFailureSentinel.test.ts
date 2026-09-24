import { describe, expect, it, vi } from 'vitest';
import {
	runThrowingScheduledFunction,
	SCHEDULED_SENTINEL_SWITCH,
} from './helpers/scheduledFailureSentinel';
import { newHarness } from './testModules';

/**
 * A test whose own assertions pass while a function it scheduled throws. It
 * is skipped in every normal run; `scheduledFailureGate.test.ts` spawns vitest
 * on this file with the switch set and asserts that both tests fail, the one
 * with a silenced console.error included.
 */
describe.skipIf(process.env[SCHEDULED_SENTINEL_SWITCH] !== '1')(
	'scheduled failure sentinel',
	() => {
		it('passes its assertions while a scheduled function throws', async () => {
			await runThrowingScheduledFunction(newHarness());
			expect(true).toBe(true);
		});

		it('passes its assertions while console.error is mocked and a scheduled function throws', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			await runThrowingScheduledFunction(newHarness());
			expect(true).toBe(true);
		});
	}
);
