/**
 * #925 regressions for `GET /delivery-logs` pagination: following `nextCursor`
 * until it is absent returns every matching entry exactly once, in order,
 * whatever the page size, filters and day boundaries, and no single request
 * reads an unbounded amount of the stream.
 */

import { describe, expect, it, vi } from 'vitest';
import type { MtaConfig } from '../../config.js';
import {
	DeliveryLogRedisFake,
	type FakeEvent,
} from '../../__tests__/helpers/deliveryLogRedisFake.js';
import {
	DeliveryLogQueryError,
	QUERY_MAX_READS,
	QUERY_SCAN_BUDGET,
	queryDeliveryLogs,
	type DeliveryLogQuery,
} from '../deliveryLogger.js';
import { createDeliveryLogRoutes } from '../../routes/deliveryLogs.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DAY_1 = '2026-09-29';
const DAY_2 = '2026-09-30';
const DAY_3 = '2026-10-01';
const STATUSES = ['delivered', 'bounced', 'deferred'];

interface Seeded extends FakeEvent {
	id: string;
	date: string;
}

/** `n` events split over the given days in order, orgs and statuses cycling. */
function seed(fake: DeliveryLogRedisFake, n: number, days: string[]): Seeded[] {
	const seeded: Seeded[] = [];
	for (let i = 0; i < n; i++) {
		const date = days[Math.floor((i * days.length) / n)]!;
		const event = {
			messageId: `m-${i}`,
			orgId: `org-${i % 3}`,
			status: STATUSES[Math.floor(i / 3) % STATUSES.length]!,
		};
		seeded.push({ ...event, date, id: fake.recordIndexed(date, event) });
	}
	return seeded;
}

/** Follow `nextCursor` to the end, recording what every request cost. */
async function walk(fake: DeliveryLogRedisFake, query: DeliveryLogQuery) {
	const ids: string[] = [];
	const reads: number[] = [];
	const examined: number[] = [];
	let cursor: string | undefined;
	for (let request = 0; request < 10_000; request++) {
		fake.resetCounts();
		const page = await queryDeliveryLogs(fake.asRedis(), { ...query, cursor });
		reads.push(fake.calls['xrange'] ?? 0);
		examined.push(fake.entriesReturned);
		expect(page.entries.length).toBeLessThanOrEqual(query.limit ?? 100);
		ids.push(...page.entries.map((e) => e.id));
		if (!page.nextCursor) return { ids, reads, examined, requests: request + 1 };
		expect(page.nextCursor).not.toBe(cursor);
		cursor = page.nextCursor;
	}
	throw new Error('pagination did not end');
}

const FILTERS: Array<[string, Partial<DeliveryLogQuery>, (e: Seeded) => boolean]> = [
	['no filter', {}, () => true],
	['orgId', { orgId: 'org-1' }, (e) => e.orgId === 'org-1'],
	[
		'orgId and status',
		{ orgId: 'org-2', status: 'bounced' },
		(e) => e.orgId === 'org-2' && e.status === 'bounced',
	],
	['an absent orgId', { orgId: 'absent-org' }, () => false],
];

describe('queryDeliveryLogs pagination', () => {
	describe.each([1000, 1001, 2000])('%i entries over two days', (n) => {
		it.each(FILTERS)('returns every match once with %s', async (_label, filter, matches) => {
			const fake = new DeliveryLogRedisFake();
			const seeded = seed(fake, n, [DAY_1, DAY_2]);
			const expected = seeded.filter(matches).map((e) => e.id);

			for (const limit of [1, 7, 100, 1000]) {
				if (limit === 1 && expected.length > 1000) continue; // covered by 7
				const { ids } = await walk(fake, {
					startDate: DAY_1,
					endDate: DAY_3,
					limit,
					...filter,
				});
				expect(new Set(ids).size).toBe(ids.length);
				expect(ids).toEqual(expected);
			}
		});
	});

	it('ends a page that fills exactly at the end of a day with a cursor into the next day', async () => {
		const fake = new DeliveryLogRedisFake();
		const seeded = seed(fake, 200, [DAY_1, DAY_2]);

		const first = await queryDeliveryLogs(fake.asRedis(), {
			startDate: DAY_1,
			endDate: DAY_2,
			limit: 100,
		});
		expect(first.entries.map((e) => e.id)).toEqual(seeded.slice(0, 100).map((e) => e.id));
		expect(first.nextCursor).toBe(`${DAY_2}:0-0`);

		const second = await queryDeliveryLogs(fake.asRedis(), {
			startDate: DAY_1,
			endDate: DAY_2,
			limit: 100,
			cursor: first.nextCursor,
		});
		expect(second.entries.map((e) => e.id)).toEqual(seeded.slice(100).map((e) => e.id));
		expect(second.nextCursor).toBeUndefined();
	});

	it('applies a cursor only to the day it came from', async () => {
		// The second day's stream IDs sort before the first day's (an MTA clock
		// ahead of Redis around midnight), so one cursor for every day loses them.
		const fake = new DeliveryLogRedisFake();
		const day2 = seed(fake, 5, [DAY_2]);
		const day1 = seed(fake, 5, [DAY_1]);

		const { ids } = await walk(fake, { startDate: DAY_1, endDate: DAY_2, limit: 3 });

		expect(ids).toEqual([...day1, ...day2].map((e) => e.id));
	});

	it('bounds every request and still reaches matches behind a long run of other entries', async () => {
		const fake = new DeliveryLogRedisFake();
		for (let i = 0; i < 25_000; i++) {
			fake.recordIndexed(DAY_3, { messageId: `x-${i}`, orgId: 'other-org', status: 'delivered' });
		}
		const targets = [0, 1, 2].map((i) =>
			fake.recordIndexed(DAY_3, { messageId: `t-${i}`, orgId: 'target-org', status: 'bounced' })
		);

		const { ids, reads, examined, requests } = await walk(fake, {
			date: DAY_3,
			orgId: 'target-org',
			limit: 100,
		});

		expect(ids).toEqual(targets);
		expect(requests).toBe(3);
		expect(Math.max(...examined)).toBeLessThanOrEqual(QUERY_SCAN_BUDGET);
		expect(examined.reduce((a, b) => a + b, 0)).toBe(25_003);
		expect(Math.max(...reads)).toBeLessThanOrEqual(QUERY_MAX_READS);
	});

	it('pages through a long range of empty days a bounded number of reads at a time', async () => {
		const fake = new DeliveryLogRedisFake();
		const seeded = seed(fake, 3, [DAY_3]);

		const { ids, reads, requests } = await walk(fake, {
			startDate: '2026-01-01',
			endDate: DAY_3,
			limit: 10,
		});

		expect(ids).toEqual(seeded.map((e) => e.id));
		expect(Math.max(...reads)).toBe(QUERY_MAX_READS);
		expect(requests).toBe(Math.ceil(274 / QUERY_MAX_READS));
	});

	it('accepts a cursor from an older MTA and returns the entry it points at', async () => {
		const fake = new DeliveryLogRedisFake();
		const seeded = seed(fake, 5, [DAY_3]);

		// The older MTA's nextCursor after a two-entry page: the third entry,
		// which it then skipped on the next page.
		const page = await queryDeliveryLogs(fake.asRedis(), {
			date: DAY_3,
			limit: 2,
			cursor: seeded[2]!.id,
		});

		expect(page.entries.map((e) => e.id)).toEqual([seeded[2]!.id, seeded[3]!.id]);
		expect(page.nextCursor).toBe(`${DAY_3}:${seeded[3]!.id}`);
	});

	it.each(['garbage', '2026-02-30:1-0', '2026-10-01:abc', `${DAY_3}:1-0;drop`])(
		'rejects the malformed cursor %s',
		async (cursor) => {
			const fake = new DeliveryLogRedisFake();
			await expect(queryDeliveryLogs(fake.asRedis(), { date: DAY_3, cursor })).rejects.toThrow(
				DeliveryLogQueryError
			);
			expect(fake.calls['xrange']).toBeUndefined();
		}
	);
});

describe('GET /delivery-logs', () => {
	const config = { apiKey: 'test-master-key' } as MtaConfig;
	const get = (fake: DeliveryLogRedisFake, query: string) =>
		createDeliveryLogRoutes(fake.asRedis(), config).request(`/?${query}`, {
			headers: { Authorization: 'Bearer test-master-key' },
		});

	it('pages with the cursor it returns and keeps the response shape', async () => {
		const fake = new DeliveryLogRedisFake();
		const seeded = seed(fake, 5, [DAY_3]);
		const page = async (cursor?: string) => {
			const query = `date=${DAY_3}&limit=1&orgId=org-0`;
			const response = await get(
				fake,
				cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query
			);
			expect(response.status).toBe(200);
			return (await response.json()) as { entries: Array<{ id: string }>; nextCursor?: string };
		};

		const first = await page();
		expect(Object.keys(first).sort()).toEqual(['entries', 'nextCursor']);
		expect(first.entries.map((e) => e.id)).toEqual([seeded[0]!.id]);
		const second = await page(first.nextCursor);
		expect(second.entries.map((e) => e.id)).toEqual([seeded[3]!.id]);
		// The last org-0 entry may be the last of the day; the next page says so.
		expect(await page(second.nextCursor)).toEqual({ entries: [] });
	});

	it('answers 400 for a malformed cursor', async () => {
		const response = await get(new DeliveryLogRedisFake(), `date=${DAY_3}&cursor=not-a-cursor`);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Invalid cursor' });
	});
});
