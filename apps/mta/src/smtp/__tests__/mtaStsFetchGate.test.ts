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
const FAILED_KEY = `mta:sts-fetch-failures:${DOMAIN}`;
const BUDGET_KEY = `mta:sts-fetch-budget:${DOMAIN}`;

// The recipient domain's owner controls both the DNS id and the
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

		it('keeps both records when two ids fail at the same time', async () => {
			let rejectA!: (err: Error) => void;
			let rejectB!: (err: Error) => void;
			const fetchA = vi.fn(() => new Promise<string>((_, reject) => (rejectA = reject)));
			const fetchB = vi.fn(() => new Promise<string>((_, reject) => (rejectB = reject)));

			const a = callSettled('id-a', fetchA);
			const b = callSettled('id-b', fetchB);
			await vi.waitFor(() => {
				expect(fetchA).toHaveBeenCalled();
				expect(fetchB).toHaveBeenCalled();
			});
			rejectA(new Error('a down'));
			rejectB(new Error('b down'));
			await Promise.all([a, b]);

			expect((await redis.zrange(FAILED_KEY, '0', '-1')).sort()).toEqual(['id-a', 'id-b']);
			// Retrying either id right away is backed off: no third fetch.
			expect(await callSettled('id-b', fetchB)).toBeNull();
			expect(await callSettled('id-a', fetchA)).toBeNull();
			expect(fetchA.mock.calls.length + fetchB.mock.calls.length).toBe(2);
		});

		it('drops failures older than the backoff when recording a new one', async () => {
			const stale = Date.now() - (STS_FETCH_FAILURE_BACKOFF_SECONDS + 1) * 1000;
			await redis.zadd(FAILED_KEY, stale, 'id-old');

			await callSettled('id-a', failing());

			expect(await redis.zrange(FAILED_KEY, '0', '-1')).toEqual(['id-a']);
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

			expect(await redis.zrange(FAILED_KEY, '0', '-1')).toEqual(
				Array.from({ length: STS_FAILED_IDS_KEPT }, (_, i) => `id-${i + 2}`)
			);
		});

		it('lets an id fetch again once its 5-minute backoff has passed', async () => {
			const stale = Date.now() - (STS_FETCH_FAILURE_BACKOFF_SECONDS + 1) * 1000;
			await redis.zadd(FAILED_KEY, stale, 'id-a');
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it('a successful fetch records no backoff', async () => {
			const fetch = vi.fn(() => Promise.resolve('policy'));

			await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch);
			await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch);

			expect(fetch).toHaveBeenCalledTimes(2);
			expect(await redis.exists(FAILED_KEY)).toBe(0);
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

		// The counter and its TTL are set in one script, so the key can't be
		// left without a TTL; a counter that lost one anyway (e.g. written by an
		// older build) is repaired on the next call, under the limit or over it.
		it('repairs a TTL-less counter below the limit', async () => {
			await redis.set(BUDGET_KEY, '1');
			expect(await redis.ttl(BUDGET_KEY)).toBe(-1);
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
			expect(await redis.get(BUDGET_KEY)).toBe('2');
			expect(await redis.ttl(BUDGET_KEY)).toBe(STS_FETCH_BUDGET_WINDOW_SECONDS);
		});

		it('repairs a TTL-less counter over the limit, so it cannot lock forever', async () => {
			await redis.set(BUDGET_KEY, String(STS_FETCH_BUDGET));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', failing())).toBeNull();
			expect(await redis.ttl(BUDGET_KEY)).toBe(STS_FETCH_BUDGET_WINDOW_SECONDS);
		});

		it('does not extend a running window', async () => {
			await redis.set(BUDGET_KEY, '1', 'EX', 100);

			await gatedPolicyFetch(redis, DOMAIN, 'id-a', () => Promise.resolve('policy'));
			expect(await redis.ttl(BUDGET_KEY)).toBe(100);
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
			expect(await redis.zcard(FAILED_KEY)).toBe(1);
		});

		it('an untracked run finishing does not evict a later tracked run for its key', async () => {
			// Cap 1: a pending fetch on another domain fills the map, so run A for
			// (example.com, id-a) is untracked. Once the slot frees, run B for the
			// same key is tracked. A settling must leave B's entry alone.
			const pending = () => {
				let release!: (value: string) => void;
				const fetch = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
				return { fetch, release: (value: string) => release(value) };
			};
			const filler = pending();
			const a = pending();
			const b = pending();
			const third = vi.fn(() => Promise.resolve('third'));

			const fillerRun = gatedPolicyFetch(redis, 'other.example', 'id-x', filler.fetch, 1);
			const aRun = gatedPolicyFetch(redis, DOMAIN, 'id-a', a.fetch, 1);
			await vi.waitFor(() => expect(filler.fetch).toHaveBeenCalled());
			await vi.waitFor(() => expect(a.fetch).toHaveBeenCalled());

			filler.release('filler');
			await fillerRun;
			const bRun = gatedPolicyFetch(redis, DOMAIN, 'id-a', b.fetch, 1);
			await vi.waitFor(() => expect(b.fetch).toHaveBeenCalled());

			a.release('a');
			expect(await aRun).toBe('a');
			// B is still pending and still tracked: this call joins it.
			const thirdRun = gatedPolicyFetch(redis, DOMAIN, 'id-a', third, 1);
			b.release('b');

			expect(await Promise.all([bRun, thirdRun])).toEqual(['b', 'b']);
			expect(third).not.toHaveBeenCalled();
			// Two of the domain's budget slots, not three.
			expect(await redis.get(BUDGET_KEY)).toBe('2');
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
			vi.spyOn(redis, 'zscore').mockRejectedValue(new Error('READONLY'));
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
		});

		it('fetches when the budget cannot be counted', async () => {
			vi.spyOn(redis, 'eval').mockRejectedValue(new Error('READONLY'));
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
		});

		it('passes the fetch error on when the backoff cannot be written', async () => {
			const realEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
			// The budget script passes; the failure-recording script rejects.
			vi.spyOn(redis, 'eval').mockImplementation(((...args: unknown[]) =>
				String(args[2]).startsWith('mta:sts-fetch-failures:')
					? Promise.reject(new Error('READONLY'))
					: realEval(...args)) as never);

			await expect(gatedPolicyFetch(redis, DOMAIN, 'id-a', failing())).rejects.toThrow(
				/ECONNREFUSED/
			);
		});

		it('ignores a backoff key of the wrong type', async () => {
			await redis.set(FAILED_KEY, '{not a sorted set');
			const fetch = vi.fn(() => Promise.resolve('policy'));

			expect(await gatedPolicyFetch(redis, DOMAIN, 'id-a', fetch)).toBe('policy');
		});
	});
});
