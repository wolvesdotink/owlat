/**
 * The backend's retry schedules, pinned as literal milliseconds. Each one now
 * comes from a RetryPolicy and `nextDelay` (@owlat/shared/retryPolicy); these
 * values are what the inline formulas produced before, so a change to a policy
 * or to how a caller indexes it shows up here as a behaviour change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLlmRetry } from '../llm/retryPolicy';
import { remoteOpRetryDelayMs } from '../../mail/external/remoteOps';
import { replayDelayMs } from '../../delivery/sendCompletionFailures';
import { backoffMs, budgetBackoffMs } from '../../mail/interpret/retry';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('external mail remote ops', () => {
	it('waits 1, 2, 4 … minutes after the n-th failure, capped at an hour', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(remoteOpRetryDelayMs)).toEqual([
			MINUTE,
			MINUTE,
			2 * MINUTE,
			4 * MINUTE,
			8 * MINUTE,
			16 * MINUTE,
			32 * MINUTE,
			HOUR,
			HOUR,
		]);
	});
});

describe('send completion replays', () => {
	it('waits 10 min after no replay, doubling per replay, capped at 6 h', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 9].map(replayDelayMs)).toEqual([
			10 * MINUTE,
			20 * MINUTE,
			40 * MINUTE,
			80 * MINUTE,
			160 * MINUTE,
			320 * MINUTE,
			6 * HOUR,
			6 * HOUR,
		]);
	});
});

describe('interpretation retries', () => {
	it('repairs wait 5, 20 and 80 minutes', () => {
		expect([0, 1, 2].map(backoffMs)).toEqual([5 * MINUTE, 20 * MINUTE, 80 * MINUTE]);
		expect(backoffMs(-1)).toBe(5 * MINUTE);
	});

	it('budget deferrals wait 5 min after the first, doubling to 6 h', () => {
		expect([1, 2, 3, 4, 5, 6, 7, 24].map(budgetBackoffMs)).toEqual([
			5 * MINUTE,
			10 * MINUTE,
			20 * MINUTE,
			40 * MINUTE,
			80 * MINUTE,
			160 * MINUTE,
			320 * MINUTE,
			6 * HOUR,
		]);
		expect(budgetBackoffMs(0)).toBe(5 * MINUTE);
	});
});

describe('LLM dispatch retries', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** The waits withLlmRetry schedules while `run` fails `failures` times, then succeeds. */
	async function waitsFor(failures: number, error: unknown): Promise<number[]> {
		vi.useFakeTimers();
		const timeout = vi.spyOn(globalThis, 'setTimeout');
		let calls = 0;
		const run = async () => {
			calls += 1;
			if (calls <= failures) throw error;
			return 'ok';
		};
		const result = withLlmRetry(run);
		await vi.runAllTimersAsync();
		await expect(result).resolves.toEqual({ value: 'ok', attempts: failures + 1 });
		return timeout.mock.calls.map(([, ms]) => ms as number);
	}

	it('waits 500 ms, then 1 s', async () => {
		expect(await waitsFor(2, { statusCode: 503, message: 'overloaded' })).toEqual([500, 1_000]);
	});

	it('waits for a longer retry-after instead', async () => {
		const limited = {
			statusCode: 429,
			message: 'rate limited',
			responseHeaders: { 'retry-after': '2' },
		};
		expect(await waitsFor(2, limited)).toEqual([2_000, 2_000]);
	});
});
