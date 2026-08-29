import { describe, expect, it } from 'vitest';
import {
	countOtherSessions,
	describeLastSeen,
	describeUserAgent,
	toActiveSessionRows,
	type AuthSessionRecord,
} from '~/utils/accountSessions';

const CHROME_MAC =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const EDGE_WINDOWS =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const SAFARI_IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0';

function session(overrides: Partial<AuthSessionRecord> = {}): AuthSessionRecord {
	return {
		id: 'sess_1',
		token: 'tok_1',
		createdAt: '2026-08-01T10:00:00.000Z',
		updatedAt: '2026-08-01T10:00:00.000Z',
		expiresAt: '2026-09-01T10:00:00.000Z',
		ipAddress: '203.0.113.4',
		userAgent: CHROME_MAC,
		...overrides,
	};
}

describe('describeUserAgent', () => {
	/**
	 * Ordering is the only thing that can go wrong in a matcher list, and it goes
	 * wrong silently: every Chromium UA still contains `Chrome`, and Chrome's
	 * still contains `Safari`, so a list in the obvious alphabetical order
	 * labels every Edge session "Chrome" and every Chrome session "Safari".
	 */
	it('names Edge from a UA that also claims Chrome and Safari', () => {
		expect(describeUserAgent(EDGE_WINDOWS).browser).toEqual({
			key: 'dashboard.preferences.security.device.browsers.edge',
		});
	});

	it('names Chrome from a UA that also claims Safari', () => {
		expect(describeUserAgent(CHROME_MAC).browser).toEqual({
			key: 'dashboard.preferences.security.device.browsers.chrome',
		});
	});

	it('names real Safari', () => {
		expect(describeUserAgent(SAFARI_IPHONE).browser).toEqual({
			key: 'dashboard.preferences.security.device.browsers.safari',
		});
	});

	it.each([
		[CHROME_MAC, 'macos', 'computer', 'lucide:monitor'],
		[EDGE_WINDOWS, 'windows', 'computer', 'lucide:monitor'],
		[SAFARI_IPHONE, 'ios', 'phone', 'lucide:smartphone'],
		[FIREFOX_LINUX, 'linux', 'computer', 'lucide:monitor'],
	])('places %# on its platform', (ua, platform, kind, icon) => {
		const device = describeUserAgent(ua);
		expect(device.platform).toEqual({
			key: `dashboard.preferences.security.device.platforms.${platform}`,
		});
		expect(device.kind).toBe(kind);
		expect(device.icon).toBe(icon);
	});

	it('calls the packaged app an installed app, not the OS it runs on', () => {
		const device = describeUserAgent(
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 Tauri/2.0 Owlat/0.4.4'
		);
		expect(device.browser).toEqual({
			key: 'dashboard.preferences.security.device.browsers.owlatDesktop',
		});
		expect(device.kind).toBe('desktop-app');
		// The platform is still reported — only the KIND is overridden.
		expect(device.platform).toEqual({
			key: 'dashboard.preferences.security.device.platforms.linux',
		});
	});

	/**
	 * A wrong device name on a security page is worse than none: it invites the
	 * user to recognise a session that is not theirs.
	 */
	it.each([[null], [undefined], [''], ['   '], ['curl/8.5.0']])(
		'admits it cannot place %p',
		(ua) => {
			const device = describeUserAgent(ua);
			expect(device.kind).toBe('unknown');
			expect(device.browser).toEqual({
				key: 'dashboard.preferences.security.device.browsers.unknown',
			});
			expect(device.platform).toEqual({
				key: 'dashboard.preferences.security.device.platforms.unknown',
			});
		}
	);

	it('names the half it recognises when the other half is unplaceable', () => {
		const device = describeUserAgent('Mozilla/5.0 (SomeFutureOS) Firefox/200.0');
		expect(device.browser).toEqual({
			key: 'dashboard.preferences.security.device.browsers.firefox',
		});
		expect(device.platform).toEqual({
			key: 'dashboard.preferences.security.device.platforms.unknown',
		});
		expect(device.kind).toBe('unknown');
	});
});

describe('toActiveSessionRows', () => {
	it('pins the current session first, then orders the rest by last seen', () => {
		const rows = toActiveSessionRows(
			[
				session({ id: 'a', token: 'tok_a', updatedAt: '2026-08-01T09:00:00.000Z' }),
				session({ id: 'b', token: 'tok_b', updatedAt: '2026-08-01T12:00:00.000Z' }),
				session({ id: 'c', token: 'tok_current', updatedAt: '2026-07-01T00:00:00.000Z' }),
			],
			{ currentToken: 'tok_current' }
		);
		expect(rows.map((row) => row.id)).toEqual(['c', 'b', 'a']);
		expect(rows.map((row) => row.isCurrent)).toEqual([true, false, false]);
	});

	it('marks nothing current when the current token is unknown', () => {
		const rows = toActiveSessionRows([session()], {});
		expect(rows[0]!.isCurrent).toBe(false);
	});

	it('parses the wire dates into epoch milliseconds', () => {
		const [row] = toActiveSessionRows([session()]);
		expect(row!.createdAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'));
		expect(row!.expiresAt).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
		expect(row!.lastSeenAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'));
	});

	// `updatedAt` is what BetterAuth refreshes on each session read, so it is the
	// real "last seen"; a row that somehow lacks one must not read as 1970.
	it('falls back to createdAt when updatedAt is missing', () => {
		const [row] = toActiveSessionRows([session({ updatedAt: '' })]);
		expect(row!.lastSeenAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'));
	});

	it('reports a missing IP as null rather than an empty string', () => {
		const rows = toActiveSessionRows([
			session({ id: 'a', token: 'a', ipAddress: null }),
			session({ id: 'b', token: 'b', ipAddress: '  ' }),
		]);
		expect(rows.map((row) => row.ipAddress)).toEqual([null, null]);
	});

	it('keeps the revoke handle, which is the token and not the id', () => {
		const [row] = toActiveSessionRows([session({ id: 'sess_9', token: 'tok_9' })]);
		expect(row!.token).toBe('tok_9');
		expect(row!.id).toBe('sess_9');
	});
});

describe('countOtherSessions', () => {
	it('counts what sign-out-everywhere-else would actually end', () => {
		const rows = toActiveSessionRows(
			[
				session({ id: 'a', token: 'tok_a' }),
				session({ id: 'b', token: 'tok_b' }),
				session({ id: 'c', token: 'tok_current' }),
			],
			{ currentToken: 'tok_current' }
		);
		expect(countOtherSessions(rows)).toBe(2);
	});

	it('is zero when the only session is this one', () => {
		const rows = toActiveSessionRows([session({ token: 'tok_current' })], {
			currentToken: 'tok_current',
		});
		expect(countOtherSessions(rows)).toBe(0);
	});
});

describe('describeLastSeen', () => {
	const now = Date.parse('2026-08-27T12:00:00.000Z');

	it.each([
		[0, { key: 'dashboard.preferences.security.device.lastSeen.now' }],
		[30_000, { key: 'dashboard.preferences.security.device.lastSeen.now' }],
		[
			5 * 60_000,
			{ key: 'dashboard.preferences.security.device.lastSeen.minutes', params: { count: 5 } },
		],
		[
			3 * 3_600_000,
			{ key: 'dashboard.preferences.security.device.lastSeen.hours', params: { count: 3 } },
		],
		[
			2 * 86_400_000,
			{ key: 'dashboard.preferences.security.device.lastSeen.days', params: { count: 2 } },
		],
	])('buckets %i ms ago', (elapsed, expected) => {
		expect(describeLastSeen(now - elapsed, now)).toEqual(expected);
	});

	// Past a week the page shows the absolute date; inventing a "5 weeks ago"
	// bucket would be less precise than the thing it replaces.
	it('declines to bucket anything older than a week', () => {
		expect(describeLastSeen(now - 8 * 86_400_000, now)).toBeNull();
	});

	/**
	 * The timestamp comes from the server and `now` from the browser, so a few
	 * seconds of skew is normal. It must read as "now", never as "in 2 minutes".
	 */
	it('reads a future timestamp as now rather than as the future', () => {
		expect(describeLastSeen(now + 90_000, now)).toEqual({
			key: 'dashboard.preferences.security.device.lastSeen.now',
		});
	});

	it('returns nothing for a timestamp that never parsed', () => {
		expect(describeLastSeen(0, now)).toBeNull();
	});
});
