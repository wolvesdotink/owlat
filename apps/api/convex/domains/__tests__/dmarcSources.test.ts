import { describe, expect, it } from 'vitest';
import {
	identifySource,
	readinessFrom,
	READY_STREAK_DAYS,
	rollUpDmarcRows,
	type DmarcSourceRow,
} from '../dmarcSources';
import { DAY_MS } from '../../lib/constants';

const own = { ips: new Set(['203.0.113.10']), hosts: new Set(['mail.example.com']) };

function row(overrides: Partial<DmarcSourceRow>): DmarcSourceRow {
	return {
		sourceIp: '192.0.2.1',
		count: 10,
		rangeBeginMs: Date.UTC(2026, 8, 30),
		disposition: 'none',
		isDkimAligned: true,
		isSpfAligned: false,
		dkimResults: [],
		spfResults: [],
		overrideReasons: [],
		...overrides,
	};
}

describe('identifySource', () => {
	it('recognises our own pool IPs and EHLO name', () => {
		expect(identifySource(row({ sourceIp: '203.0.113.10' }), own).kind).toBe('owlat');
		expect(identifySource(row({ sourceHost: 'MAIL.example.com' }), own).kind).toBe('owlat');
	});

	it('names known senders by PTR or by a passing DKIM/SPF domain', () => {
		expect(identifySource(row({ sourceHost: 'a1-2.smtp-out.amazonses.com' }), own)).toMatchObject({
			kind: 'known',
			label: 'Amazon SES',
		});
		expect(
			identifySource(row({ dkimResults: [{ domain: 'sg.sendgrid.net', result: 'pass' }] }), own)
		).toMatchObject({ kind: 'known', label: 'SendGrid' });
		// A failing result proves nothing about who sent it.
		expect(
			identifySource(row({ dkimResults: [{ domain: 'sendgrid.net', result: 'fail' }] }), own).kind
		).toBe('unknown');
	});

	it('groups unknown senders by their PTR organisation, else by IP', () => {
		expect(identifySource(row({ sourceHost: 'static.1.2.example-host.net' }), own)).toEqual({
			key: 'host:example-host.net',
			kind: 'unknown',
			label: 'example-host.net',
		});
		expect(identifySource(row({}), own)).toEqual({
			key: 'ip:192.0.2.1',
			kind: 'unknown',
			label: '192.0.2.1',
		});
	});
});

describe('readinessFrom', () => {
	const day = (messageCount: number, alignedCount: number) => ({
		date: 'x',
		messageCount,
		alignedCount,
	});

	it('counts the newest days at or above 99%, skipping days without reports', () => {
		const trend = [day(100, 50), day(100, 100), day(0, 0), day(1000, 991)];
		expect(readinessFrom(trend)).toMatchObject({ streakDays: 2, latestAlignedRate: 0.991 });
	});

	it('is ready at the required streak', () => {
		const trend = Array.from({ length: READY_STREAK_DAYS }, () => day(10, 10));
		expect(readinessFrom(trend).isReady).toBe(true);
		expect(readinessFrom([]).latestAlignedRate).toBeNull();
	});

	it('stops unjudged at the first day whose rows were not all read', () => {
		const trend = Array.from({ length: READY_STREAK_DAYS + 2 }, (_, i) => ({
			date: `2026-09-${String(i + 1).padStart(2, '0')}`,
			messageCount: 10,
			alignedCount: 10,
		}));
		// Days 1 to 3 are incomplete: thirteen complete clean days remain.
		const readiness = readinessFrom(trend, '2026-09-03');
		expect(readiness).toMatchObject({ streakDays: 13, isReady: false, isIncomplete: true });
		expect(readinessFrom(trend)).toMatchObject({ isReady: true, isIncomplete: false });
		// A failing complete day ends the run before the cut: nothing incomplete about it.
		const failing = trend.map((point) =>
			point.date === '2026-09-10' ? { ...point, alignedCount: 0 } : point
		);
		expect(readinessFrom(failing, '2026-09-03')).toMatchObject({
			streakDays: 6,
			isIncomplete: false,
		});
	});
});

describe('rollUpDmarcRows', () => {
	it('keeps rows outside the shown window out of totals but in readiness', () => {
		const now = Date.UTC(2026, 9, 2, 12);
		const rows = [
			row({ rangeBeginMs: now - DAY_MS, count: 10 }),
			row({ rangeBeginMs: now - 20 * DAY_MS, count: 5, isDkimAligned: false }),
		];
		const rollup = rollUpDmarcRows(rows, own, 7, now);
		expect(rollup.messageCount).toBe(10);
		expect(rollup.alignedRate).toBe(1);
		expect(rollup.trend).toHaveLength(7);
		// The failing day 20 days back ends the streak after the clean day.
		expect(rollup.readiness.streakDays).toBe(1);
	});

	it('judges readiness on the last 30 days whatever window is shown', () => {
		const now = Date.UTC(2026, 9, 2, 12);
		const rows = [row({ rangeBeginMs: now - 45 * DAY_MS, count: 10 })];
		const wide = rollUpDmarcRows(rows, own, 90, now);
		expect(wide.messageCount).toBe(10);
		expect(wide.readiness).toMatchObject({ streakDays: 0, latestAlignedRate: null });
		expect(rollUpDmarcRows(rows, own, 30, now).readiness).toEqual(wide.readiness);
	});

	it('leaves the day of the first omitted row and older ones out of readiness', () => {
		const now = Date.UTC(2026, 9, 2, 12);
		const rows = Array.from({ length: READY_STREAK_DAYS }, (_, i) =>
			row({ rangeBeginMs: now - (i + 1) * DAY_MS })
		);
		// The read stopped inside the oldest day: its failing rows were never seen.
		const omitted = now - READY_STREAK_DAYS * DAY_MS - 60_000;
		const truncated = rollUpDmarcRows(rows, own, 30, now, omitted);
		expect(truncated.readiness).toMatchObject({
			streakDays: READY_STREAK_DAYS - 1,
			isReady: false,
			isIncomplete: true,
		});
		expect(rollUpDmarcRows(rows, own, 30, now).readiness.isReady).toBe(true);
	});
});
