/**
 * Bounded retry with backoff.
 *
 * Concluding `unknown` is expensive (it preserves quarantine and holds the
 * ramp), so a transient resolver failure is retried — but a dead resolver must
 * never stall the sweep, so the attempts and the total wait are hard-bounded
 * and no attempt starts after the budget is spent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dns/promises', () => ({ resolve4: vi.fn() }));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolve4 } from 'dns/promises';
import {
	checkDnsbl,
	LOOKUP_MAX_ATTEMPTS,
	LOOKUP_RETRY_BASE_DELAY_MS,
	LOOKUP_TOTAL_BUDGET_MS,
} from '../dnsbl.js';
import { createRecordingLookupDeps, dnsError } from './dnsblFixtures.js';

describe('DNSBL bounded retry', () => {
	beforeEach(() => vi.clearAllMocks());

	it('retries a transient failure and accepts the answer that arrives on the retry', async () => {
		vi.mocked(resolve4)
			.mockRejectedValueOnce(dnsError('ESERVFAIL'))
			.mockResolvedValueOnce(['127.0.0.2']);
		const { deps, delays } = createRecordingLookupDeps();

		expect(await checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', deps)).toBe('listed');
		expect(resolve4).toHaveBeenCalledTimes(2);
		expect(delays).toEqual([LOOKUP_RETRY_BASE_DELAY_MS]);
	});

	it('concludes unknown after the attempt budget, with exponential backoff and no unbounded wait', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ETIMEOUT'));
		const { deps, delays } = createRecordingLookupDeps();

		expect(await checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', deps)).toBe('unknown');
		expect(resolve4).toHaveBeenCalledTimes(LOOKUP_MAX_ATTEMPTS);
		expect(delays).toEqual([LOOKUP_RETRY_BASE_DELAY_MS, LOOKUP_RETRY_BASE_DELAY_MS * 2]);
		expect(delays.reduce((total, delay) => total + delay, 0)).toBeLessThan(LOOKUP_TOTAL_BUDGET_MS);
	});

	it('never retries an answered lookup', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ENOTFOUND'));
		const clean = createRecordingLookupDeps();
		expect(await checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', clean.deps)).toBe('clean');
		expect(resolve4).toHaveBeenCalledTimes(1);
		expect(clean.delays).toEqual([]);

		vi.clearAllMocks();
		vi.mocked(resolve4).mockResolvedValue(['127.0.0.2']);
		const listed = createRecordingLookupDeps();
		expect(await checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', listed.deps)).toBe(
			'listed'
		);
		expect(resolve4).toHaveBeenCalledTimes(1);
		expect(listed.delays).toEqual([]);
	});

	it('stops retrying once the elapsed budget leaves no room for the next backoff', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ESERVFAIL'));
		const { deps, delays } = createRecordingLookupDeps([0, LOOKUP_TOTAL_BUDGET_MS]);

		expect(await checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', deps)).toBe('unknown');
		expect(resolve4).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]);
	});

	it('treats a backwards clock as budget exhaustion rather than waiting forever', async () => {
		vi.mocked(resolve4).mockRejectedValue(dnsError('ESERVFAIL'));
		const { deps, delays } = createRecordingLookupDeps([10_000, 0]);

		expect(await checkDnsbl('10.0.0.1', 'spamhaus', 'zen.spamhaus.org', deps)).toBe('unknown');
		expect(resolve4).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]);
	});
});
