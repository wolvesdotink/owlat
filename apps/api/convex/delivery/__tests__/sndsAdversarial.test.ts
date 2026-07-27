/**
 * P4-1 (e): hostile and degenerate SNDS input.
 *
 * The feed and the URLs behind it are externally supplied. Everything here is
 * a "the provider sent us garbage" case: oversized bodies, malformed rows,
 * replayed and back-dated reads, and rows describing an IP this deployment
 * does not own. The invariant is uniform — bound it, drop it, count it, never
 * throw and never let it move a gate.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import {
	normalizeSndsIp,
	parseSndsFeed,
	SNDS_MAX_ROWS,
	type SndsDayObservation,
} from '../sndsFeed';
import { parsePoolAllowlist, parseSndsFeedUrls, SNDS_MAX_FEEDS } from '../snds';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const DAY_MS = 24 * 60 * 60 * 1_000;
const FEED_URL = 'https://snds.example.test/feed';

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env['SNDS_DATA_FEED_URLS'];
	delete process.env['MTA_IP_POOLS'];
});

function sndsStamp(at: Date): string {
	const hours24 = at.getUTCHours();
	const hour = hours24 % 12 === 0 ? 12 : hours24 % 12;
	return `${at.getUTCMonth() + 1}/${at.getUTCDate()}/${at.getUTCFullYear()} ${hour}:00 ${hours24 < 12 ? 'AM' : 'PM'}`;
}

function yesterday(hour: number): Date {
	const now = new Date();
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, hour, 0, 0)
	);
}

function row(ip: string): string {
	return [
		ip,
		sndsStamp(yesterday(0)),
		sndsStamp(yesterday(8)),
		'10',
		'10',
		'10',
		'GREEN',
		'< 0.1%',
		sndsStamp(yesterday(0)),
		'0',
		'mail.example.test',
		'bounces@example.test',
		'',
	].join(',');
}

function observation(overrides: Partial<SndsDayObservation> = {}): SndsDayObservation {
	const periodStart = Math.floor((Date.now() - DAY_MS) / DAY_MS) * DAY_MS;
	return {
		ip: '203.0.113.10',
		periodStart,
		complaintBand: 'lt_0_1',
		filterResult: 'green',
		trapHits: 0,
		messageRecipients: 10,
		rcptCommands: 10,
		dataCommands: 10,
		...overrides,
	};
}

describe('oversized and malformed feeds', () => {
	it('caps the row count and reports truncation instead of parsing forever', () => {
		const body = Array.from({ length: SNDS_MAX_ROWS + 50 }, () => row('203.0.113.10')).join('\n');
		const parsed = parseSndsFeed(body);
		expect(parsed.rows).toHaveLength(SNDS_MAX_ROWS);
		expect(parsed.truncated).toBe(true);
	});

	it('drops an absurdly long line rather than storing it', () => {
		const parsed = parseSndsFeed(`${row('203.0.113.10')},${'x'.repeat(5000)}`);
		expect(parsed.rows).toEqual([]);
		expect(parsed.dropped).toBe(1);
	});

	it('drops every malformed row shape, counts them, and throws nothing', () => {
		const body = [
			'', // blank
			'203.0.113.10', // no columns
			'not-an-ip,7/20/2026 12:00 AM,7/20/2026 8:00 AM,1,1,1,GREEN,< 0.1%',
			'999.1.1.1,7/20/2026 12:00 AM,7/20/2026 8:00 AM,1,1,1,GREEN,< 0.1%',
			'203.0.113.10,2/31/2026 12:00 AM,2/31/2026 8:00 AM,1,1,1,GREEN,< 0.1%',
			// Window ends before it starts.
			'203.0.113.10,7/20/2026 8:00 AM,7/20/2026 12:00 AM,1,1,1,GREEN,< 0.1%',
			// Counters that are not counters — kept as a row, with those fields absent.
			'203.0.113.10,7/20/2026 12:00 AM,7/20/2026 8:00 AM,-5,NaN,1e9,GREEN,< 0.1%',
		].join('\n');

		const parsed = parseSndsFeed(body);
		expect(parsed.dropped).toBe(5);
		expect(parsed.rows).toHaveLength(1);
		expect(parsed.rows[0]?.rcptCommands).toBeUndefined();
		expect(parsed.rows[0]?.dataCommands).toBeUndefined();
		expect(parsed.rows[0]?.messageRecipients).toBeUndefined();
	});

	it('refuses ambiguous IP spellings so one address has exactly one key', () => {
		expect(normalizeSndsIp(' 203.0.113.10 ')).toBe('203.0.113.10');
		expect(normalizeSndsIp('203.000.113.010')).toBeNull();
		expect(normalizeSndsIp('203.0.113.256')).toBeNull();
		expect(normalizeSndsIp('203.0.113.10:25')).toBeNull();
		expect(normalizeSndsIp('x'.repeat(200))).toBeNull();
		expect(normalizeSndsIp('2001:db8::1')).toBe('2001:db8::1');
	});

	it('bounds and sanitizes the configured feed list', () => {
		const many = Array.from({ length: SNDS_MAX_FEEDS + 5 }, (_, i) => `https://f${i}.test/x`);
		expect(parseSndsFeedUrls(many.join(','))).toHaveLength(SNDS_MAX_FEEDS);
		// Duplicates collapse, non-https is refused, junk is ignored — never a throw.
		expect(parseSndsFeedUrls('https://a.test/x https://a.test/x ftp://b.test junk')).toEqual([
			'https://a.test/x',
		]);
	});
});

describe('replay, staleness and foreign IPs', () => {
	it('deduplicates a replayed read and refuses a back-dated one', async () => {
		const t = convexTest(schema, modules);
		const fetchedAt = Date.now();

		const first = await t.mutation(internal.delivery.snds.ingestDays, {
			observations: [observation({ complaintBand: '0_1_to_0_2' })],
			fetchedAt,
		});
		expect(first).toMatchObject({ ingested: 1, replayed: 0 });

		// Exactly the same read again: acknowledged, not written twice.
		const replay = await t.mutation(internal.delivery.snds.ingestDays, {
			observations: [observation({ complaintBand: '0_1_to_0_2' })],
			fetchedAt,
		});
		expect(replay).toMatchObject({ ingested: 0, replayed: 1 });

		// A late-arriving OLDER read must not overwrite fresher data.
		const stale = await t.mutation(internal.delivery.snds.ingestDays, {
			observations: [observation({ complaintBand: 'gte_0_9' })],
			fetchedAt: fetchedAt - 60_000,
		});
		expect(stale).toMatchObject({ ingested: 0, rejected: 1 });

		const rows = await t.run(async (ctx) => ctx.db.query('sndsIpDailyStats').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.complaintBand).toBe('0_1_to_0_2');
	});

	it('rejects observations outside the ingest window or with impossible counters', async () => {
		const t = convexTest(schema, modules);
		const fetchedAt = Date.now();
		const result = await t.mutation(internal.delivery.snds.ingestDays, {
			observations: [
				observation({ periodStart: Date.now() + 5 * DAY_MS }),
				observation({ periodStart: Date.now() - 60 * DAY_MS }),
				observation({
					periodStart: Math.floor((Date.now() - DAY_MS) / DAY_MS) * DAY_MS + 3_600_000,
				}), // not a UTC midnight
				observation({ trapHits: -1 }),
				observation({ messageRecipients: 1.5 }),
				observation({ ip: 'NOT-AN-IP' }),
			],
			fetchedAt,
		});

		expect(result).toMatchObject({ ingested: 0, rejected: 6 });
		expect(await t.run(async (ctx) => ctx.db.query('sndsIpDailyStats').collect())).toEqual([]);
	});

	it('drops feed rows for IPs this deployment does not own', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = FEED_URL;
		// The SNDS key covers a registered range, so the feed can legitimately
		// carry someone else's address. The declared pool is the allowlist.
		process.env['MTA_IP_POOLS'] = '203.0.113.10';
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response([row('203.0.113.10'), row('198.51.100.7')].join('\n'), { status: 200 })
			)
		);

		const summary = await t.action(internal.delivery.snds.poll, {});
		expect(summary).toMatchObject({ ingested: 1, foreignIps: 1 });

		const rows = await t.run(async (ctx) => ctx.db.query('sndsIpDailyStats').collect());
		expect(rows.map((stored) => stored.ip)).toEqual(['203.0.113.10']);
	});

	it('never throws on a malformed pool declaration', () => {
		expect(parsePoolAllowlist('203.0.113.10, oops, , 203.0.113.11')).toEqual(
			new Set(['203.0.113.10', '203.0.113.11'])
		);
		expect(parsePoolAllowlist(undefined).size).toBe(0);
	});
});
