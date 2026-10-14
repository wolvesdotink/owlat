import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	gatedPolicyFetch,
	STS_FAILED_IDS_KEPT,
	STS_FETCH_BUDGET,
	STS_FETCH_BUDGET_WINDOW_SECONDS,
	STS_FETCH_FAILURE_BACKOFF_SECONDS,
} from '../mtaStsFetchGate.js';

const DOMAIN = 'example.com';
const FAILED_KEY = `mta:sts-fetch-failed:${DOMAIN}`;
const BUDGET_KEY = `mta:sts-fetch-budget:${DOMAIN}`;

// Issue #1326: the recipient domain's owner controls both the DNS id and the
// policy host, so the fetch path must stay bounded however the ids move.
describe('gatedPolicyFetch', () => {
	let redis: RealRedis;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
	});

	afterEach(async () => {
		await redis.flushall();
		vi.restoreAllMocks();
	});

	const failing = () => vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

	async function callSettled<T>(id: string, fetch: () => Promise<T>) {
		return gatedPolicyFetch(redis, DOMAIN, id, fetch).catch((err: Error) => err);
	}

	describe('per-id backoff', () => {
		it('backs a failed id off: the second call does not fetch', async () => {
			const fetch = failing();

			expect(await callSettled('id-a', fetch)).toBeInstanceOf(Error);
			expect(await callSettled('id-a', fetch)).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(await redis.ttl(FAILED_KEY)).toBe(STS_FETCH_FAILURE_BACKOFF_SECONDS);
		});

		it('alternating two failing ids fetches each once, not on every call', async () => {
			const fetch = failing();

			for (let i = 0; i < 20; i++) await callSettled(i % 2 ? 'id-b' : 'id-a', fetch);

			expect(fetch).toHaveBeenCalledTimes(2);
		});

		it(`keeps the last ${STS_FAILED_IDS_KEPT} failed ids per domain`, async () => {
			// Clear the domain budget between calls so only the id list is exercised.
			for (let i = 0; i < STS_FAILED_IDS_KEPT + 2; i++) {
				await redis.del(BUDGET_KEY);
				await callSettled(`id-${i}`, failing());
			}

			const stored = JSON.parse((await redis.get(FAILED_KEY))!) as Array<{ id: string }>;
			expect(stored.map((entry) => entry.id)).toEqual(
				Array.from({ length: STS_FAILED_IDS_KEPT }, (_, i) => `id-${i + 2}`)
			);
		});

		it('lets an id fetch again once its 5-minute backoff has passed', async () => {
			const stale = Date.now() - (STS_FETCH_FAILURE_BACKOFF_SECONDS + 1) * 1000;
			await redis.set(FAILED_KEY, JSON.stringify([{ id: 'id-a', at: stale }]));
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it('a successful fetch records no backoff', async () => {
			const fetch = vi.fn(() => Promise.resolve('policy'));

			await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch);
			await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch);

			expect(fetch).toHaveBeenCalledTimes(2);
			expect(await redis.get(FAILED_KEY)).toBeNull();
		});
	});

	describe('per-domain budget', () => {
		it(`rotating unique ids get at most ${STS_FETCH_BUDGET} fetches per window`, async () => {
			const fetch = failing();

			for (let i = 0; i < 20; i++) await callSettled(`rotating-${i}`, fetch);

			expect(fetch).toHaveBeenCalledTimes(STS_FETCH_BUDGET);
			expect(await redis.ttl(BUDGET_KEY)).toBe(STS_FETCH_BUDGET_WINDOW_SECONDS);
		});

		it('counts successful fetches too', async () => {
			const fetch = vi.fn(() => Promise.resolve('policy'));

			const results = [];
			for (let i = 0; i < STS_FETCH_BUDGET + 2; i++) {
				results.push(await gatedPolicyFetch(redis, DOMAIN, `id-${i}`, fetch));
			}

			expect(fetch).toHaveBeenCalledTimes(STS_FETCH_BUDGET);
			expect(results.slice(-2)).toEqual([null, null]);
		});

		it('re-arms a spent budget whose window lost its TTL', async () => {
			await redis.set(BUDGET_KEY, String(STS_FETCH_BUDGET));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', failing())).toBeNull();
			expect(await redis.ttl(BUDGET_KEY)).toBe(STS_FETCH_BUDGET_WINDOW_SECONDS);
		});

		it('keeps budgets per domain', async () => {
			const fetch = vi.fn(() => Promise.resolve('policy'));
			for (let i = 0; i < STS_FETCH_BUDGET; i++) {
				await gatedPolicyFetch(redis, DOMAIN, `id-${i}`, fetch);
			}

			expect(await gatedPolicyFetch(redis, 'other.example', 'id-0', fetch)).toBe('policy');
		});
	});

	describe('coalescing', () => {
		it('20 concurrent calls for one domain and id share one fetch', async () => {
			let release!: (value: string) => void;
			const fetch = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));

			const calls = Array.from({ length: 20 }, () =>
				gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)
			);
			await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
			release('policy');

			expect(await Promise.all(calls)).toEqual(Array(20).fill('policy'));
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it('a shared failure reaches every caller and is recorded once', async () => {
			const fetch = failing();

			const results = await Promise.all(
				Array.from({ length: 5 }, () => callSettled('id-a', fetch))
			);

			expect(results.every((result) => result instanceof Error)).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(JSON.parse((await redis.get(FAILED_KEY))!)).toHaveLength(1);
		});

		it('does not coalesce different ids', async () => {
			const fetch = vi.fn(() => Promise.resolve('policy'));

			await Promise.all([
				gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch),
				gatedPolicyFetch(redis, DOMAIN, 'id-b', fetch),
			]);

			expect(fetch).toHaveBeenCalledTimes(2);
		});
	});

	describe('storage errors fail open', () => {
		it('fetches when the backoff cannot be read', async () => {
			vi.spyOn(redis, 'get').mockRejectedValue(new Error('READONLY'));
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
		});

		it('fetches when the budget cannot be counted', async () => {
			vi.spyOn(redis, 'incr').mockRejectedValue(new Error('READONLY'));
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
		});

		it('passes the fetch error on when the backoff cannot be written', async () => {
			vi.spyOn(redis, 'set').mockRejectedValue(new Error('READONLY'));

			await expect(gatedPolicyFetch(redis, DOMAIN, 'id-a', failing())).rejects.toThrow(
				/ECONNREFUSED/
			);
		});

		it('ignores a corrupt backoff entry', async () => {
			await redis.set(FAILED_KEY, '{not json');
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
		});
	});
});
