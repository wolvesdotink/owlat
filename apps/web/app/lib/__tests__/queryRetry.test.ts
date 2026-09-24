import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import {
	TRANSIENT_RETRY_LIMIT,
	createTransientRetry,
	isTransientQueryError,
	transientRetryDelay,
} from '../queryRetry';

describe('isTransientQueryError', () => {
	it('retries a function execution timeout', () => {
		expect(
			isTransientQueryError(
				new Error(
					'[CONVEX Q(campaigns/senders:listForPicker)] [Request ID: 1] Server Error\nUncaught Error: Function execution timed out (maximum duration: 1s)'
				)
			)
		).toBe(true);
	});

	it('retries the redacted production "Server Error"', () => {
		expect(
			isTransientQueryError(
				new Error('[CONVEX Q(topics/topics:list)] [Request ID: 1] Server Error')
			)
		).toBe(true);
	});

	it('leaves a ConvexError terminal, categorized or not', () => {
		expect(isTransientQueryError(new ConvexError('Not allowed'))).toBe(false);
		expect(
			isTransientQueryError(new ConvexError({ category: 'forbidden', message: 'Not allowed' }))
		).toBe(false);
	});

	it('leaves validation failures terminal', () => {
		expect(
			isTransientQueryError(new Error('ArgumentValidationError: Object is missing field `id`'))
		).toBe(false);
		expect(
			isTransientQueryError(new Error("Could not find public function for 'topics:gone'"))
		).toBe(false);
	});
});

describe('transientRetryDelay', () => {
	it('doubles from one second and caps at eight', () => {
		const mid = () => 0.5;
		expect([0, 1, 2, 3, 4].map((n) => transientRetryDelay(n, mid))).toEqual([
			1_000, 2_000, 4_000, 8_000, 8_000,
		]);
	});

	it('spreads each delay by at most 20%', () => {
		expect(transientRetryDelay(0, () => 0)).toBe(800);
		expect(transientRetryDelay(0, () => 1)).toBe(1_200);
	});
});

describe('createTransientRetry', () => {
	const timeout = new Error('Function execution timed out');

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('schedules up to the limit, then declines', () => {
		const retry = createTransientRetry();
		const resubscribe = vi.fn();

		for (let i = 0; i < TRANSIENT_RETRY_LIMIT; i++) {
			expect(retry.schedule(timeout, resubscribe)).toBe(true);
			vi.advanceTimersByTime(10_000);
		}

		expect(resubscribe).toHaveBeenCalledTimes(TRANSIENT_RETRY_LIMIT);
		expect(retry.schedule(timeout, resubscribe)).toBe(false);
	});

	it('declines a terminal error without spending the budget', () => {
		const retry = createTransientRetry(1);
		expect(retry.schedule(new ConvexError('no'), vi.fn())).toBe(false);
		expect(retry.schedule(timeout, vi.fn())).toBe(true);
	});

	it('reset restores the budget', () => {
		const retry = createTransientRetry(1);
		retry.schedule(timeout, vi.fn());
		vi.advanceTimersByTime(10_000);
		expect(retry.schedule(timeout, vi.fn())).toBe(false);

		retry.reset();
		expect(retry.schedule(timeout, vi.fn())).toBe(true);
	});

	it('cancel drops the pending resubscribe', () => {
		const retry = createTransientRetry();
		const resubscribe = vi.fn();
		retry.schedule(timeout, resubscribe);

		retry.cancel();
		vi.advanceTimersByTime(10_000);

		expect(resubscribe).not.toHaveBeenCalled();
	});
});
