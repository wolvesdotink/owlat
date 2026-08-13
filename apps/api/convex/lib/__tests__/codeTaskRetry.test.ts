import { describe, it, expect } from 'vitest';
import {
	CODE_TASK_MAX_ATTEMPTS,
	CODE_TASK_RETRY_DELAYS_MS,
	codeTaskRetryDecision,
	codeTaskRetryDelayMs,
} from '../codeTaskRetry';

const NOW = 1_700_000_000_000;

describe('codeTaskRetryDelayMs', () => {
	it('walks the delay table as attempts accumulate', () => {
		expect(codeTaskRetryDelayMs(1)).toBe(CODE_TASK_RETRY_DELAYS_MS[0]);
		expect(codeTaskRetryDelayMs(2)).toBe(CODE_TASK_RETRY_DELAYS_MS[1]);
	});

	it('is monotonically non-decreasing (a retry never backs off less than the last)', () => {
		const delays = [1, 2, 3, 4, 5].map(codeTaskRetryDelayMs);
		for (let i = 1; i < delays.length; i++) {
			expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
		}
	});

	it('clamps past both ends of the table', () => {
		// A legacy row with no attempt count still gets the first delay, and a
		// raised maxAttempts keeps reusing the longest one.
		expect(codeTaskRetryDelayMs(0)).toBe(CODE_TASK_RETRY_DELAYS_MS[0]);
		expect(codeTaskRetryDelayMs(99)).toBe(
			CODE_TASK_RETRY_DELAYS_MS[CODE_TASK_RETRY_DELAYS_MS.length - 1]
		);
	});
});

describe('codeTaskRetryDecision', () => {
	it('retries while attempts remain, scheduling the next one after the backoff', () => {
		expect(codeTaskRetryDecision({ attempts: 1, maxAttempts: 3 }, NOW)).toEqual({
			retry: true,
			attempts: 1,
			nextAttemptAt: NOW + CODE_TASK_RETRY_DELAYS_MS[0],
		});
	});

	it('gives up once attempts reach the ceiling', () => {
		expect(codeTaskRetryDecision({ attempts: 3, maxAttempts: 3 }, NOW)).toEqual({
			retry: false,
			attempts: 3,
		});
	});

	it('never retries a task whose ceiling is a single attempt', () => {
		expect(codeTaskRetryDecision({ attempts: 1, maxAttempts: 1 }, NOW).retry).toBe(false);
	});

	it('falls back to the default ceiling for rows written before retries existed', () => {
		expect(codeTaskRetryDecision({}, NOW)).toMatchObject({ retry: true, attempts: 0 });
		expect(codeTaskRetryDecision({ attempts: CODE_TASK_MAX_ATTEMPTS }, NOW).retry).toBe(false);
	});
});
