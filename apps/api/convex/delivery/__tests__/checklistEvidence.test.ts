import { describe, expect, it } from 'vitest';
import { DNS_RETRY_DELAYS_MS, boundedObservedValues, nextDnsRetry } from '../checklistEvidence';

describe('Deliverability Center DNS retry policy', () => {
	it('advances through 1m, 5m, 15m, 60m and then stops', () => {
		let retryIndex = 0;
		const observed: number[] = [];
		for (let attempt = 0; attempt < DNS_RETRY_DELAYS_MS.length; attempt += 1) {
			const retry = nextDnsRetry(retryIndex, 'pending-dns', true)!;
			observed.push(retry.delayMs);
			retryIndex = retry.retryIndex;
		}
		expect(observed).toEqual([
			DNS_RETRY_DELAYS_MS[0],
			DNS_RETRY_DELAYS_MS[1],
			DNS_RETRY_DELAYS_MS[2],
			DNS_RETRY_DELAYS_MS[3],
		]);
		expect(retryIndex).toBe(DNS_RETRY_DELAYS_MS.length);
		expect(nextDnsRetry(retryIndex, 'pending-dns', true)).toBeNull();
	});

	it('resets the chain when validation reaches pass or confirmed failure', () => {
		expect(nextDnsRetry(3, 'pass', true)).toBeNull();
		expect(nextDnsRetry(3, 'fail', true)).toBeNull();
		expect(nextDnsRetry(3, 'pending-dns', false)).toBeNull();
	});

	it('bounds validator-unavailable retries instead of rescheduling forever', () => {
		expect(nextDnsRetry(0, 'warn', false, 'checklist.orchestrator')).toMatchObject({
			delayMs: DNS_RETRY_DELAYS_MS[0],
			retryIndex: 1,
		});
		expect(
			nextDnsRetry(DNS_RETRY_DELAYS_MS.length, 'warn', false, 'checklist.orchestrator')
		).toBeNull();
	});

	it('bounds and sanitizes persisted raw observations with an explicit truncation marker', () => {
		const values = Array.from(
			{ length: 18 },
			(_, index) => `observation-${index}\u0000${'x'.repeat(600)}`
		);
		const bounded = boundedObservedValues(values);

		expect(bounded).toHaveLength(16);
		expect(bounded.slice(0, -1).every((value) => value.length <= 512)).toBe(true);
		expect(bounded.join('')).not.toContain('\u0000');
		expect(bounded[bounded.length - 1]).toBe('truncated-observations=3');
	});
});
