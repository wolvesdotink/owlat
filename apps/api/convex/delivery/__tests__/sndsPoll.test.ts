/**
 * P4-1 (a): the SNDS feed parser and the poll that stores it.
 *
 * The feed is the only window into Microsoft's IP reputation, and Microsoft
 * publishes it as a headerless CSV of sub-day activity windows carrying a
 * complaint BAND. These tests pin the parse across every documented band, the
 * per-(IP, day) fold, partial rows, unknown band values and empty days.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import {
	complaintBandSeverity,
	createSndsDayFold,
	foldedSndsDays,
	foldSndsDays,
	parseComplaintBand,
	parseFilterResult,
	parseSndsFeed,
	parseSndsTimestamp,
	SNDS_COMPLAINT_BANDS,
	sndsCellKey,
	type SndsComplaintBand,
	type SndsDayObservation,
	type SndsFeedRow,
} from '../sndsFeed';
import { startOfDayUtc } from '../../lib/clock';

import { modules } from './helpers/convexModules';

const FEED_URL = 'https://sendersupport.olc.protection.outlook.com/snds/ada/example-key';

/**
 * Fold ONE feed's rows — a test convenience, deliberately not production API.
 *
 * The poller folds ACROSS feeds into a single accumulator, because SNDS ranges
 * overlap and one (IP, day) can appear in two feeds. A one-shot single-feed
 * aggregate has no production caller, so it lives here rather than as an
 * exported seam nothing uses (D20).
 */
function aggregateSndsDays(rows: readonly SndsFeedRow[]): SndsDayObservation[] {
	const fold = createSndsDayFold();
	foldSndsDays(fold, rows);
	return foldedSndsDays(fold);
}

/**
 * A FIXED simulated instant, mid-day and mid-month.
 *
 * Every fixture here is a UTC DAY, and the ingest window's edges are UTC
 * midnights: a suite that builds its days from the real clock puts a fixture on
 * the wrong side of the window whenever a run straddles midnight. Only `Date` is
 * faked, so convex-test's own scheduling still runs on real timers.
 */
const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	delete process.env['SNDS_DATA_FEED_URLS'];
	delete process.env['MTA_IP_POOLS'];
});

/** Render a UTC instant the way the SNDS feed does: `M/D/YYYY h:mm AM`. */
function sndsStamp(at: Date): string {
	const hours24 = at.getUTCHours();
	const hour = hours24 % 12 === 0 ? 12 : hours24 % 12;
	const minutes = String(at.getUTCMinutes()).padStart(2, '0');
	return `${at.getUTCMonth() + 1}/${at.getUTCDate()}/${at.getUTCFullYear()} ${hour}:${minutes} ${hours24 < 12 ? 'AM' : 'PM'}`;
}

function feedRow(fields: {
	ip: string;
	start: Date;
	end: Date;
	rcpt?: number;
	data?: number;
	recipients?: number;
	filter?: string;
	complaint?: string;
	trapHits?: number;
	helo?: string;
}): string {
	return [
		fields.ip,
		sndsStamp(fields.start),
		sndsStamp(fields.end),
		String(fields.rcpt ?? 0),
		String(fields.data ?? 0),
		String(fields.recipients ?? 0),
		fields.filter ?? 'GREEN',
		fields.complaint ?? '< 0.1%',
		sndsStamp(fields.start),
		String(fields.trapHits ?? 0),
		fields.helo ?? 'mail.example.test',
		'bounces@example.test',
		'',
	].join(',');
}

/** A UTC hour on the day `days` before {@link NOW} — never before "today". */
function dayAgo(days: number, hour: number): Date {
	const base = new Date(NOW);
	return new Date(
		Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - days, hour, 0, 0)
	);
}

describe('SNDS feed parsing', () => {
	it('parses every documented complaint band into its enumerated value', () => {
		const cases: Array<[string, SndsComplaintBand]> = [
			['', 'unknown'],
			['< 0.1%', 'lt_0_1'],
			['<0.1%', 'lt_0_1'],
			['0.1% - < 0.2%', '0_1_to_0_2'],
			['0.2% - < 0.3%', '0_2_to_0_3'],
			['0.3% - < 0.4%', '0_3_to_0_4'],
			['0.4% - < 0.5%', '0_4_to_0_5'],
			['0.5% - < 0.6%', '0_5_to_0_6'],
			['0.6% - < 0.7%', '0_6_to_0_7'],
			['0.7% - < 0.8%', '0_7_to_0_8'],
			['0.8% - < 0.9%', '0_8_to_0_9'],
			['> 0.9%', 'gte_0_9'],
		];
		for (const [raw, expected] of cases) {
			expect(parseComplaintBand(raw), raw).toBe(expected);
		}
		// Every enumerated band is reachable from some feed spelling.
		expect(new Set(cases.map(([, band]) => band)).size).toBe(SNDS_COMPLAINT_BANDS.length);

		// …and ONLY those spellings. The relational grammar is strict at both the
		// operator and the unit, because both loosenings resolve to a band the
		// value does not warrant:
		//  - `<= 0.1%` means "at most 0.1%", and exactly 0.1% is `0_1_to_0_2`, not
		//    `lt_0_1` — the cleanest band and the only positive promotion evidence;
		//  - a bare `< 0.1` has no unit, so it is not a documented spelling at all.
		for (const raw of [
			'<= 0.1%',
			'<=0.1%',
			'>= 0.9%',
			'>=0.9%',
			'< 0.1',
			'<0.1',
			'> 0.9',
			'>0.9',
		]) {
			expect(parseComplaintBand(raw), raw).toBe('unknown');
		}
	});

	it('is forward-compatible: an unrecognised band value is unknown, never a throw', () => {
		for (const raw of [
			'SOMETHING NEW',
			'n/a',
			'—',
			'ØØ',
			'unbanded',
			'%%%',
			// Relational spellings whose bound is NOT a band edge. These are the
			// dangerous ones: reading `<` as "the cleanest band" would let reworded
			// feed text turn a breach into a pass and let the share rise.
			'<0.5%',
			'< 0.5%',
			'<0.9%',
			'< 1%',
			'>0.1%',
			'> 0.2%',
			// A relational prefix with no readable bound names nothing at all.
			'<',
			'> ',
			'<abc',
			// A LOCALIZED decimal separator. This is a real band spelled in a
			// locale this parser has not been taught to read, so it is unknown —
			// never the band the digits happen to look like, and above all never
			// the cleanest one.
			'0,8% - < 0,9%',
			'0,1% - < 0,2%',
			// A range WIDER than one band spans several of them and names none.
			// Both of these start at zero, so a parser that read only the lower
			// bound would call a nine-band range the cleanest band.
			'0% - < 0.5%',
			'0.0% - < 0.9%',
			'0% - < 1%',
			// A range that does not START on a band edge.
			'0.05% - < 0.15%',
			// Prose. The digits name a band; the sentence around them does not.
			'Less than 0.1%',
			'0.1% or less',
			// The numeric token is not the band's lower bound at all — a parser
			// that scanned for the first number anywhere in the field would read
			// a rate out of a note or an address.
			'n/a 0.5%',
			'IP 203.0.113.10 0.5%',
			// Trailing text after an otherwise valid spelling: matched whole or
			// not at all.
			'< 0.1% (estimated)',
			'0.1% - < 0.2% *',
		]) {
			expect(() => parseComplaintBand(raw), raw).not.toThrow();
			expect(parseComplaintBand(raw), raw).toBe('unknown');
		}
		// The band EDGES still read exactly as Microsoft spells them.
		expect(parseComplaintBand('< 0.1%')).toBe('lt_0_1');
		expect(parseComplaintBand('<0.05%')).toBe('lt_0_1');
		expect(parseComplaintBand('> 0.9%')).toBe('gte_0_9');
		expect(parseComplaintBand('> 5%')).toBe('gte_0_9');
		// A one-band-wide range at either end of the scale is still that band.
		expect(parseComplaintBand('0% - < 0.1%')).toBe('lt_0_1');
		expect(parseComplaintBand('0.9% - < 1.0%')).toBe('gte_0_9');
		// `unknown` is deliberately NOT the cleanest band — it has no severity.
		expect(complaintBandSeverity('unknown')).toBeNull();
		expect(complaintBandSeverity('lt_0_1')).toBe(0);
	});

	it('parses filter results and refuses anything else', () => {
		expect(parseFilterResult('GREEN')).toBe('green');
		expect(parseFilterResult(' yellow ')).toBe('yellow');
		expect(parseFilterResult('Red')).toBe('red');
		expect(parseFilterResult('MAUVE')).toBe('unknown');
		expect(parseFilterResult('')).toBe('unknown');
	});

	it('parses SNDS timestamps as UTC and rejects impossible dates', () => {
		expect(parseSndsTimestamp('7/20/2026 12:00 AM')).toBe(Date.UTC(2026, 6, 20, 0, 0, 0));
		expect(parseSndsTimestamp('7/20/2026 12:30 PM')).toBe(Date.UTC(2026, 6, 20, 12, 30, 0));
		expect(parseSndsTimestamp('7/20/2026 11:15:30 PM')).toBe(Date.UTC(2026, 6, 20, 23, 15, 30));
		expect(parseSndsTimestamp('2/31/2026 1:00 AM')).toBeNull();
		expect(parseSndsTimestamp('13/1/2026 1:00 AM')).toBeNull();
		expect(parseSndsTimestamp('7/20/2026 13:00 PM')).toBeNull();
		expect(parseSndsTimestamp('not a date')).toBeNull();
	});

	it('folds sub-day windows into one observation per IP per day', () => {
		const start = new Date(Date.UTC(2026, 6, 20, 0, 0, 0));
		const feed = [
			feedRow({
				ip: '203.0.113.10',
				start,
				end: new Date(Date.UTC(2026, 6, 20, 8, 0, 0)),
				rcpt: 1000,
				data: 900,
				recipients: 880,
				filter: 'GREEN',
				complaint: '< 0.1%',
				trapHits: 0,
			}),
			feedRow({
				ip: '203.0.113.10',
				start: new Date(Date.UTC(2026, 6, 20, 8, 0, 0)),
				end: new Date(Date.UTC(2026, 6, 20, 16, 0, 0)),
				rcpt: 500,
				data: 500,
				recipients: 500,
				filter: 'YELLOW',
				complaint: '0.2% - < 0.3%',
				trapHits: 2,
			}),
			feedRow({
				ip: '203.0.113.11',
				start,
				end: new Date(Date.UTC(2026, 6, 20, 8, 0, 0)),
				recipients: 10,
				filter: 'GREEN',
			}),
		].join('\n');

		const parsed = parseSndsFeed(feed);
		expect(parsed.dropped).toBe(0);
		expect(parsed.rows).toHaveLength(3);

		const days = aggregateSndsDays(parsed.rows);
		expect(days).toHaveLength(2);
		const first = days[0];
		expect(first).toBeDefined();
		expect(first?.ip).toBe('203.0.113.10');
		expect(first?.periodStart).toBe(Date.UTC(2026, 6, 20));
		// Counters sum; band and filter take the WORST of the day, not the last.
		expect(first?.rcptCommands).toBe(1500);
		expect(first?.messageRecipients).toBe(1380);
		expect(first?.trapHits).toBe(2);
		expect(first?.complaintBand).toBe('0_2_to_0_3');
		expect(first?.filterResult).toBe('yellow');
		expect(days[1]?.ip).toBe('203.0.113.11');
	});

	it('attributes a window to the UTC day it STARTED in', () => {
		const parsed = parseSndsFeed(
			feedRow({
				ip: '203.0.113.10',
				start: new Date(Date.UTC(2026, 6, 20, 23, 0, 0)),
				end: new Date(Date.UTC(2026, 6, 21, 7, 0, 0)),
			})
		);
		expect(aggregateSndsDays(parsed.rows)[0]?.periodStart).toBe(Date.UTC(2026, 6, 20));
		expect(startOfDayUtc(Date.UTC(2026, 6, 20, 23, 59, 59))).toBe(Date.UTC(2026, 6, 20));
	});

	it('keeps a partial row that stops after the complaint band', () => {
		const partial = [
			'203.0.113.10',
			'7/20/2026 12:00 AM',
			'7/20/2026 8:00 AM',
			'100',
			'100',
			'100',
			'GREEN',
			'< 0.1%',
		].join(',');
		const parsed = parseSndsFeed(partial);
		expect(parsed.dropped).toBe(0);
		expect(parsed.rows[0]?.trapHits).toBeUndefined();
		// A missing trap-hit column folds to zero hits, not to "unknown hits".
		expect(aggregateSndsDays(parsed.rows)[0]?.trapHits).toBe(0);
	});

	it('orders folded days NEWEST FIRST, so a capped poll drops the oldest', () => {
		// The poll caps how many observations it dispatches. Whatever the cap
		// discards is never stored, and a day that was never stored reads later as
		// a day with nothing wrong in it — so the cap must fall on the OLDEST days,
		// never on whichever addresses happen to sort last.
		const parsed = parseSndsFeed(
			[
				feedRow({
					ip: '203.0.113.99',
					start: new Date(Date.UTC(2026, 6, 18)),
					end: new Date(Date.UTC(2026, 6, 18, 8)),
				}),
				feedRow({
					ip: '203.0.113.10',
					start: new Date(Date.UTC(2026, 6, 20)),
					end: new Date(Date.UTC(2026, 6, 20, 8)),
				}),
				feedRow({
					ip: '203.0.113.11',
					start: new Date(Date.UTC(2026, 6, 20)),
					end: new Date(Date.UTC(2026, 6, 20, 8)),
				}),
			].join('\n')
		);
		expect(aggregateSndsDays(parsed.rows).map((day) => [day.periodStart, day.ip])).toEqual([
			[Date.UTC(2026, 6, 20), '203.0.113.10'],
			[Date.UTC(2026, 6, 20), '203.0.113.11'],
			[Date.UTC(2026, 6, 18), '203.0.113.99'],
		]);
	});

	it('gives distinct (IP, day) cells distinct keys, IPv6 included', () => {
		// The key exists so a Map can hold a PAIR. What it must guarantee is that
		// two different cells never fold together — the separator is chosen for
		// exactly that, since it appears in no address spelling we accept.
		const day = Date.UTC(2026, 6, 20);
		const keys = [
			sndsCellKey('203.0.113.1', 0),
			sndsCellKey('203.0.113.10', 0),
			sndsCellKey('203.0.113.10', day),
			sndsCellKey('2001:db8::1', day),
			sndsCellKey('2001:db8:0:0:0:0:0:beef', day),
		];
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('returns an empty result for an empty day, with no throw', () => {
		for (const body of ['', '\n\n', '   \r\n  \r\n']) {
			const parsed = parseSndsFeed(body);
			expect(parsed.rows).toEqual([]);
			expect(parsed.dropped).toBe(0);
			expect(aggregateSndsDays(parsed.rows)).toEqual([]);
		}
	});
});

describe('SNDS poll', () => {
	it('stores one row per IP per day and re-polls idempotently', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = FEED_URL;
		const body = [
			feedRow({ ip: '203.0.113.10', start: dayAgo(1, 0), end: dayAgo(1, 8), recipients: 500 }),
			feedRow({
				ip: '203.0.113.10',
				start: dayAgo(1, 8),
				end: dayAgo(1, 16),
				recipients: 500,
				complaint: '0.1% - < 0.2%',
				trapHits: 1,
			}),
			feedRow({ ip: '203.0.113.11', start: dayAgo(2, 0), end: dayAgo(2, 8), filter: 'RED' }),
		].join('\n');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(body, { status: 200 }))
		);

		const first = await t.action(internal.delivery.sndsPoll.poll, {});
		expect(first.enrolled).toBe(true);
		expect(first.ingested).toBe(2);
		expect(first.feedsFailed).toBe(0);

		// A LATER read of the same days: fresher `fetchedAt`, so both rows are
		// rewritten rather than acknowledged as replays. The advance is explicit —
		// on the real clock the two polls could land in the same millisecond.
		vi.setSystemTime(NOW + 60_000);
		const second = await t.action(internal.delivery.sndsPoll.poll, {});
		expect(second.ingested).toBe(2);
		expect(second.replayed).toBe(0);

		const rows = await t.run(async (ctx) => ctx.db.query('sndsIpDailyStats').collect());
		expect(rows).toHaveLength(2);
		const busy = rows.find((row) => row.ip === '203.0.113.10');
		expect(busy?.messageRecipients).toBe(1000);
		expect(busy?.complaintBand).toBe('0_1_to_0_2');
		expect(busy?.trapHits).toBe(1);
		expect(rows.find((row) => row.ip === '203.0.113.11')?.filterResult).toBe('red');
	});

	it('counts a failed feed instead of throwing', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = FEED_URL;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);

		const summary = await t.action(internal.delivery.sndsPoll.poll, {});
		expect(summary).toMatchObject({ enrolled: true, feeds: 1, feedsFailed: 1, ingested: 0 });
		expect(await t.run(async (ctx) => ctx.db.query('sndsIpDailyStats').collect())).toEqual([]);
	});

	it('drops days outside the ingest window BEFORE paying for a round trip', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = FEED_URL;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						[
							feedRow({ ip: '203.0.113.10', start: dayAgo(40, 0), end: dayAgo(40, 8) }),
							feedRow({ ip: '203.0.113.10', start: dayAgo(-2, 0), end: dayAgo(-2, 8) }),
						].join('\n'),
						{ status: 200 }
					)
			)
		);

		const summary = await t.action(internal.delivery.sndsPoll.poll, {});
		expect(summary.ingested).toBe(0);
		// Filtered in the action, so the ingest mutation is never called for them.
		expect(summary.outOfWindow).toBe(2);
		expect(summary.observations).toBe(0);
		expect(summary.rejected).toBe(0);
	});

	it('folds an IP-day reported by two overlapping feeds into one summed row', async () => {
		const t = convexTest(schema, modules);
		// SNDS keys are per registered range, and ranges overlap: the same IP-day
		// legitimately arrives twice. Both readings must land in ONE row — the second
		// carries the poll's own fetchedAt, so a per-feed fold would file it as a
		// replay and throw one feed's counters away.
		process.env['SNDS_DATA_FEED_URLS'] = `${FEED_URL}-a ${FEED_URL}-b`;
		const bodies = [
			feedRow({ ip: '203.0.113.10', start: dayAgo(1, 0), end: dayAgo(1, 8), recipients: 400 }),
			feedRow({
				ip: '203.0.113.10',
				start: dayAgo(1, 8),
				end: dayAgo(1, 16),
				recipients: 600,
				complaint: '0.2% - < 0.3%',
				trapHits: 2,
			}),
		];
		let call = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(bodies[call++] ?? '', { status: 200 }))
		);

		const summary = await t.action(internal.delivery.sndsPoll.poll, {});
		expect(summary).toMatchObject({ feeds: 2, observations: 1, ingested: 1, replayed: 0 });

		const rows = await t.run(async (ctx) => ctx.db.query('sndsIpDailyStats').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.messageRecipients).toBe(1000);
		expect(rows[0]?.trapHits).toBe(2);
		expect(rows[0]?.complaintBand).toBe('0_2_to_0_3');
	});

	it('counts a re-poll at the SAME instant as a replay, not as a second write', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = FEED_URL;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(feedRow({ ip: '203.0.113.10', start: dayAgo(1, 0), end: dayAgo(1, 8) }), {
						status: 200,
					})
			)
		);

		const first = await t.action(internal.delivery.sndsPoll.poll, {});
		expect(first).toMatchObject({ ingested: 1, replayed: 0 });

		// The clock does NOT advance: the second poll stamps the identical
		// `fetchedAt`, which is byte-for-byte the read already stored. It is
		// acknowledged and counted, never written twice and never silently dropped.
		const second = await t.action(internal.delivery.sndsPoll.poll, {});
		expect(second).toMatchObject({ observations: 1, ingested: 0, replayed: 1, rejected: 0 });

		const rows = await t.run(async (ctx) => ctx.db.query('sndsIpDailyStats').collect());
		expect(rows).toHaveLength(1);
	});
});
