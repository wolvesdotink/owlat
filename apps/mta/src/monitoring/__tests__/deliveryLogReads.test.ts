/**
 * #925 regressions: delivery-log statistics and message histories must
 * terminate, count every retained entry exactly once, and — once a day is
 * indexed — cost a constant number of Redis commands however large the day's
 * stream is.
 */

import { describe, expect, it, vi } from 'vitest';
import { DeliveryLogRedisFake } from '../../__tests__/helpers/deliveryLogRedisFake.js';
import {
	getDeliveryLogStats,
	getMessageEvents,
	MESSAGE_SCAN_PAGE_SIZE,
	STATS_SCAN_PAGE_SIZE,
} from '../deliveryLogger.js';
import { compareStreamIds, nextStreamId, scanDeliveryStream } from '../deliveryLogIndex.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const today = new Date().toISOString().split('T')[0]!;
const STATUSES = ['delivered', 'bounced', 'deferred'];

function seed(
	fake: DeliveryLogRedisFake,
	n: number,
	pick: (i: number) => { orgId: string; messageId: string },
	indexed: boolean
): void {
	for (let i = 0; i < n; i++) {
		const event = { ...pick(i), status: STATUSES[i % STATUSES.length]! };
		if (indexed) fake.recordIndexed(today, event);
		else fake.recordUnindexed(today, event);
	}
}

const pages = (n: number, size: number) => Math.floor(n / size) + 1;

describe('stream IDs', () => {
	it('computes the exclusive successor of an ID', () => {
		expect(nextStreamId('1700000000000-0')).toBe('1700000000000-1');
		expect(nextStreamId('5-18446744073709551615')).toBe('6-0');
		expect(compareStreamIds('10-0', '9-5')).toBe(1);
		expect(compareStreamIds('9-5', '9-10')).toBe(-1);
	});
});

describe.each([
	['without the indexes (Redis < 7 or an older MTA)', false],
	['on a day written before the indexes existed', true],
])('delivery log scan fallback %s', (_label, supportsXinfo) => {
	it('terminates on a full page of another organization', async () => {
		const fake = new DeliveryLogRedisFake(supportsXinfo);
		seed(fake, STATS_SCAN_PAGE_SIZE, () => ({ orgId: 'other-org', messageId: 'x' }), false);

		const stats = await getDeliveryLogStats(fake.asRedis(), today, 'target-org');

		expect(stats['total']).toBe(0);
		expect(fake.calls['xrange']).toBe(2);
		expect(fake.entriesReturned).toBe(STATS_SCAN_PAGE_SIZE);
	});

	it('finds matches that only appear after several nonmatching pages', async () => {
		const fake = new DeliveryLogRedisFake(supportsXinfo);
		seed(
			fake,
			3005,
			(i) => ({ orgId: i < 3000 ? 'other-org' : 'target-org', messageId: `m-${i}` }),
			false
		);

		const stats = await getDeliveryLogStats(fake.asRedis(), today, 'target-org');

		expect(stats['total']).toBe(5);
		expect(fake.calls['xrange']).toBe(4);
		expect(fake.entriesReturned).toBe(3005);
	});

	it.each([1000, 1001, 2000])('counts %i events exactly once across page boundaries', async (n) => {
		const targets = [0, 499, 500, 999, 1000, 1999].filter((i) => i < n);
		const fake = new DeliveryLogRedisFake(supportsXinfo);
		seed(
			fake,
			n,
			(i) => ({ orgId: 'org-1', messageId: targets.includes(i) ? 'target' : `m-${i}` }),
			false
		);

		const all = await getDeliveryLogStats(fake.asRedis(), today);
		expect(all['total']).toBe(n);
		expect(fake.entriesReturned).toBe(n);
		expect(fake.calls['xrange']).toBe(pages(n, STATS_SCAN_PAGE_SIZE));

		const org = await getDeliveryLogStats(fake.asRedis(), today, 'org-1');
		expect(org['total']).toBe(n);

		fake.resetCounts();
		const history = await getMessageEvents(fake.asRedis(), 'target');
		const ids = history.map((e) => e.id);
		expect(ids).toHaveLength(targets.length);
		expect(new Set(ids).size).toBe(ids.length);
		expect(fake.entriesReturned).toBe(n);
		// Without XINFO the two empty lookback days cost one empty XRANGE each.
		expect(fake.calls['xrange']).toBe(pages(n, MESSAGE_SCAN_PAGE_SIZE) + (supportsXinfo ? 0 : 2));
	});
});

describe('scanDeliveryStream', () => {
	it('fails instead of rereading a page that does not advance', async () => {
		const stuck = {
			xrange: vi.fn(async () =>
				Array.from({ length: 10 }, () => ['1-0', ['status', 'delivered']] as [string, string[]])
			),
		};
		await expect(
			scanDeliveryStream(stuck as never, 'mta:delivery-log:x', 10, () => {})
		).rejects.toThrow(/no progress/);
		expect(stuck.xrange).toHaveBeenCalledTimes(1);
	});
});

describe('indexed delivery log reads', () => {
	it('answers statistics and histories without reading the stream in proportion to its size', async () => {
		const costs: Array<Record<string, number>> = [];
		for (const n of [1000, 20_000]) {
			const fake = new DeliveryLogRedisFake();
			seed(
				fake,
				n,
				(i) => ({
					orgId: `org-${i % 10}`,
					messageId: i % 250 === 0 && i < 1000 ? 'target' : `m-${i}`,
				}),
				true
			);
			const redis = fake.asRedis();
			const cost: Record<string, number> = {};
			const measure = async (label: string, run: () => Promise<unknown>) => {
				fake.resetCounts();
				await run();
				cost[label] = fake.commands;
				cost[`${label}:entries`] = fake.entriesReturned;
			};

			await measure('all', async () =>
				expect((await getDeliveryLogStats(redis, today))['total']).toBe(n)
			);
			await measure('org', async () =>
				expect((await getDeliveryLogStats(redis, today, 'org-3'))['total']).toBe(n / 10)
			);
			await measure('absentOrg', async () =>
				expect((await getDeliveryLogStats(redis, today, 'absent-org'))['total']).toBe(0)
			);
			await measure('history', async () =>
				expect(await getMessageEvents(redis, 'target')).toHaveLength(4)
			);
			await measure('absentMessage', async () =>
				expect(await getMessageEvents(redis, 'absent-message')).toEqual([])
			);
			costs.push(cost);
		}

		// Identical command counts at 1,000 and 20,000 events; stream entries
		// read equal the matching events only.
		expect(costs[1]).toEqual(costs[0]);
		expect(costs[0]).toMatchObject({
			all: 5,
			'all:entries': 0,
			'absentOrg:entries': 0,
			'history:entries': 4,
			'absentMessage:entries': 0,
		});
	});

	it('reports the retained entries of a trimmed day by scanning, and skips trimmed history', async () => {
		const fake = new DeliveryLogRedisFake();
		const early = fake.recordIndexed(today, {
			messageId: 'target',
			orgId: 'org-1',
			status: 'deferred',
		});
		seed(fake, 1499, (i) => ({ orgId: 'org-1', messageId: `m-${i}` }), true);
		const late = fake.recordIndexed(today, {
			messageId: 'target',
			orgId: 'org-1',
			status: 'delivered',
		});
		fake.trim(today, 1000);

		const stats = await getDeliveryLogStats(fake.asRedis(), today, 'org-1');
		expect(stats['total']).toBe(1000);
		expect(fake.entriesReturned).toBe(1000);

		fake.resetCounts();
		const history = await getMessageEvents(fake.asRedis(), 'target');
		expect(history.map((e) => e.id)).toEqual([late]);
		expect(history.map((e) => e.id)).not.toContain(early);
		expect(fake.calls['xrange']).toBe(2);
	});

	it('scans a day that also holds entries written without the indexes', async () => {
		const fake = new DeliveryLogRedisFake();
		fake.recordUnindexed(today, { messageId: 'target', orgId: 'org-1', status: 'bounced' });
		seed(fake, 10, (i) => ({ orgId: 'org-1', messageId: `m-${i}` }), true);

		expect((await getDeliveryLogStats(fake.asRedis(), today))['total']).toBe(11);
		expect(await getMessageEvents(fake.asRedis(), 'target')).toHaveLength(1);
	});

	it('scans a day whose last index write was interrupted', async () => {
		const fake = new DeliveryLogRedisFake();
		seed(fake, 10, (i) => ({ orgId: 'org-1', messageId: `m-${i}` }), true);
		fake.recordIndexed(today, { messageId: 'target', orgId: 'org-2', status: 'failed' }, true);

		const stats = await getDeliveryLogStats(fake.asRedis(), today);
		expect(stats['total']).toBe(11);
		expect(stats['failed']).toBe(1);
		expect(fake.entriesReturned).toBe(11);
	});

	it('returns empty results for an expired or never-written day without scanning', async () => {
		const fake = new DeliveryLogRedisFake();

		const stats = await getDeliveryLogStats(fake.asRedis(), '2020-01-01', 'org-1');
		expect(stats).toEqual({
			delivered: 0,
			bounced: 0,
			deferred: 0,
			suppressed: 0,
			screened: 0,
			failed: 0,
			total: 0,
		});
		expect(await getMessageEvents(fake.asRedis(), 'target')).toEqual([]);
		expect(fake.calls['xrange']).toBeUndefined();
	});
});
