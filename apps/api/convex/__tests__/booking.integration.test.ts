/**
 * Booking page (`calendar.booking`), end to end against the real schema:
 *
 *   - the host's settings are self-scoped and validated (slug, hours, zone),
 *     and a link name belongs to one member;
 *   - the public page exists only while the flag is on and the host is live,
 *     and offers only times inside the host's rules;
 *   - a booking re-checks its slot in the same transaction (a second booking
 *     of the same time is refused), caps one guest's open bookings, and stores
 *     only the digest of the guest's manage token;
 *   - the guest's token cancels and reschedules (rotating the token), the host
 *     cancels their own bookings and nobody else's;
 *   - the HTTP routes refuse a malformed request and swallow a honeypot hit;
 *   - the host's export carries the bookings without the token digest.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { enableFeatures } from './factories';
import { hashManageToken } from '../booking/model';
import type * as SessionOrganization from '../lib/sessionOrganization';

let mockUserId = 'host-A';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const session = async () => ({
		userId: mockUserId,
		role: 'editor' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		getMutationContext: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(session),
		requireSelf: vi.fn(async (_ctx: unknown, claimed: string) => {
			if (claimed !== mockUserId) throw new Error('You can only act on your own account');
			return claimed;
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
	mockUserId = 'host-A';
});

async function setup(options: { flag?: boolean } = {}) {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	if (options.flag !== false) await enableFeatures(t, ['calendar.booking']);
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const [authUserId, name] of [
			['host-A', 'Ada Host'],
			['host-B', 'Ben Host'],
		] as const) {
			await ctx.db.insert('userProfiles', {
				authUserId,
				email: `${authUserId}@example.com`,
				name,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
	return t;
}

/** Every day 09:00-17:00 UTC, no notice, a month ahead. */
const OPEN_EVERY_DAY = Array.from({ length: 7 }, (_, weekday) => ({
	weekday,
	startMinute: 9 * 60,
	endMinute: 17 * 60,
}));

async function createPage(t: TestConvex<typeof schema>, slug = 'ada') {
	await t.mutation(api.booking.settings.saveProfile, {
		slug,
		timeZone: 'UTC',
		weeklyHours: OPEN_EVERY_DAY,
		dateOverrides: [],
		minimumNoticeMinutes: 0,
		horizonDays: 30,
		bufferMinutes: 0,
	});
	await t.mutation(api.booking.settings.saveMeetingType, {
		slug: 'intro',
		title: 'Intro call',
		durationMinutes: 30,
		location: 'Phone',
		videoUrl: 'https://video.example.com/ada',
		isActive: true,
	});
}

/** 10:00 UTC on a day well inside the horizon. */
function tenOClockInDays(days: number): number {
	const day = new Date(Date.now() + days * DAY);
	return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 10, 0, 0);
}

function reserve(
	t: TestConvex<typeof schema>,
	start: number,
	guestEmail = 'guest@example.com',
	manageToken = `bk_token_${guestEmail}_${start}`
) {
	return t.mutation(internal.booking.public.reserve, {
		slug: 'ada',
		typeSlug: 'intro',
		start,
		guestName: 'Grace Guest',
		guestEmail,
		guestTimeZone: 'Europe/Berlin',
		guestLocale: 'de-DE',
		manageToken,
	});
}

describe('host settings', () => {
	it('validates the page and keeps a link name to one member', async () => {
		const t = await setup();
		await expect(
			t.mutation(api.booking.settings.saveProfile, {
				slug: 'No Spaces',
				timeZone: 'UTC',
				weeklyHours: [],
				dateOverrides: [],
				minimumNoticeMinutes: 0,
				horizonDays: 30,
				bufferMinutes: 0,
			})
		).rejects.toThrow(/link name/i);
		await expect(
			t.mutation(api.booking.settings.saveProfile, {
				slug: 'ada',
				timeZone: 'Mars/Olympus',
				weeklyHours: [],
				dateOverrides: [],
				minimumNoticeMinutes: 0,
				horizonDays: 30,
				bufferMinutes: 0,
			})
		).rejects.toThrow(/time zone/i);
		await expect(
			t.mutation(api.booking.settings.saveProfile, {
				slug: 'ada',
				timeZone: 'UTC',
				weeklyHours: [
					{ weekday: 1, startMinute: 600, endMinute: 700 },
					{ weekday: 1, startMinute: 650, endMinute: 800 },
				],
				dateOverrides: [],
				minimumNoticeMinutes: 0,
				horizonDays: 30,
				bufferMinutes: 0,
			})
		).rejects.toThrow(/overlap/);

		await createPage(t);
		mockUserId = 'host-B';
		await expect(createPage(t)).rejects.toThrow(/taken/);
		const mine = await t.query(api.booking.settings.getMine, {});
		expect(mine.profile).toBeNull();
		expect(mine.meetingTypes).toEqual([]);
	});

	it('refuses a meeting type before the page exists and an unsafe video link', async () => {
		const t = await setup();
		await expect(
			t.mutation(api.booking.settings.saveMeetingType, {
				slug: 'intro',
				title: 'Intro',
				durationMinutes: 30,
				isActive: true,
			})
		).rejects.toThrow(/booking page first/);
		await createPage(t);
		await expect(
			t.mutation(api.booking.settings.saveMeetingType, {
				slug: 'other',
				title: 'Other',
				durationMinutes: 30,
				videoUrl: 'javascript:alert(1)',
				isActive: true,
			})
		).rejects.toThrow(/http/);
		const mine = await t.query(api.booking.settings.getMine, {});
		expect(mine.meetingTypes.map((type) => type.slug)).toEqual(['intro']);
		expect(mine.meetingTypes[0]!.url).toMatch(/\/book\/ada\/intro$/);
	});

	it('is closed while the flag is off', async () => {
		const t = await setup({ flag: false });
		await expect(t.query(api.booking.settings.getMine, {})).rejects.toThrow(/calendar\.booking/);
	});
});

describe('public page', () => {
	it('offers times inside the host’s hours and hides the video link', async () => {
		const t = await setup();
		await createPage(t);
		const from = tenOClockInDays(3) - 10 * HOUR;
		const page = await t.query(internal.booking.public.getPage, {
			slug: 'ada',
			typeSlug: 'intro',
			from,
			until: from + DAY,
		});
		expect(page).not.toBeNull();
		const { slots, meetingType, host } = page as {
			slots: number[];
			meetingType: { hasVideoLink: boolean };
			host: { name: string };
		};
		expect(host.name).toBe('Ada Host');
		expect(meetingType).toMatchObject({ hasVideoLink: true });
		expect(JSON.stringify(page)).not.toContain('video.example.com');
		// 09:00 to 16:30, every half hour.
		expect(slots).toHaveLength(16);
		expect(new Date(slots[0]!).getUTCHours()).toBe(9);
		expect(new Date(slots[slots.length - 1]!).getUTCHours()).toBe(16);
	});

	it('answers not found while the flag is off or the host is gone', async () => {
		const t = await setup();
		await createPage(t);
		await t.run(async (ctx) => {
			const profile = await ctx.db.query('userProfiles').first();
			await ctx.db.patch(profile!._id, { deletedAt: Date.now() });
		});
		expect(await t.query(internal.booking.public.getPage, { slug: 'ada' })).toBeNull();

		const off = await setup();
		await createPage(off);
		await off.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(row!._id, { featureFlags: { 'calendar.booking': false } });
		});
		expect(await off.query(internal.booking.public.getPage, { slug: 'ada' })).toBeNull();
	});
});

describe('booking', () => {
	it('books a slot once and refuses the same time again', async () => {
		const t = await setup();
		await createPage(t);
		const start = tenOClockInDays(2);
		const first = await reserve(t, start);
		expect(first).toMatchObject({
			ok: true,
			booking: { title: 'Intro call', hostName: 'Ada Host' },
		});
		const second = await reserve(t, start, 'other@example.com');
		expect(second).toEqual({ ok: false, reason: 'slot_taken' });
		// The overlapping half hour is gone too, the next one is open.
		expect(await reserve(t, start + 15 * 60_000, 'other@example.com')).toMatchObject({
			ok: false,
		});
		expect(await reserve(t, start + 30 * 60_000, 'other@example.com')).toMatchObject({ ok: true });

		const stored = await t.run((ctx) => ctx.db.query('bookings').collect());
		expect(stored[0]!.manageTokenHash).toBe(
			await hashManageToken(`bk_token_guest@example.com_${start}`)
		);
		expect(JSON.stringify(stored)).not.toContain('bk_token_');
	});

	it('refuses a time outside the host’s hours, in the past, or past the horizon', async () => {
		const t = await setup();
		await createPage(t);
		const night = tenOClockInDays(2) + 12 * HOUR;
		expect(await reserve(t, night)).toEqual({ ok: false, reason: 'slot_taken' });
		expect(await reserve(t, tenOClockInDays(-1))).toEqual({ ok: false, reason: 'slot_taken' });
		expect(await reserve(t, tenOClockInDays(40))).toEqual({ ok: false, reason: 'slot_taken' });
		expect(await reserve(t, tenOClockInDays(2) + 7 * 60_000)).toEqual({
			ok: false,
			reason: 'slot_taken',
		});
	});

	it('caps one guest’s open bookings with the host', async () => {
		const t = await setup();
		await createPage(t);
		for (let i = 0; i < 3; i++) {
			expect(await reserve(t, tenOClockInDays(2 + i), 'Same@Example.com')).toMatchObject({
				ok: true,
			});
		}
		expect(await reserve(t, tenOClockInDays(6), 'same@example.com')).toEqual({
			ok: false,
			reason: 'too_many_bookings',
		});
	});

	it('refuses an invalid guest address', async () => {
		const t = await setup();
		await createPage(t);
		expect(await reserve(t, tenOClockInDays(2), 'not-an-address')).toEqual({
			ok: false,
			reason: 'invalid_guest',
		});
	});
});

describe('managing a booking', () => {
	it('lets the guest reschedule with their token, then retires it', async () => {
		const t = await setup();
		await createPage(t);
		const start = tenOClockInDays(2);
		await reserve(t, start, 'guest@example.com', 'bk_first');
		const firstHash = await hashManageToken('bk_first');

		const managed = await t.query(internal.booking.public.getManaged, {
			manageTokenHash: firstHash,
			from: start - 2 * HOUR,
			until: start + 2 * HOUR,
		});
		// The booking's own slot counts as free when moving it.
		expect(managed?.reschedule?.slots).toContain(start);

		const moved = await t.mutation(internal.booking.public.rescheduleByToken, {
			manageTokenHash: firstHash,
			start: start + HOUR,
			nextManageToken: 'bk_second',
		});
		expect(moved).toEqual({ ok: true, startAt: start + HOUR, endAt: start + HOUR + 30 * 60_000 });
		expect(
			await t.query(internal.booking.public.getManaged, { manageTokenHash: firstHash })
		).toBeNull();
		const row = await t.run((ctx) => ctx.db.query('bookings').first());
		expect(row).toMatchObject({ startAt: start + HOUR, icalSequence: 1 });

		const cancelled = await t.mutation(internal.booking.public.cancelByToken, {
			manageTokenHash: await hashManageToken('bk_second'),
		});
		expect(cancelled).toEqual({ ok: true });
		const after = await t.run((ctx) => ctx.db.query('bookings').first());
		expect(after).toMatchObject({ status: 'cancelled', cancelSource: 'guest', icalSequence: 2 });
		// The freed time can be booked again.
		expect(await reserve(t, start + HOUR, 'next@example.com')).toMatchObject({ ok: true });
	});

	it('lets the host cancel their own bookings only', async () => {
		const t = await setup();
		await createPage(t);
		await reserve(t, tenOClockInDays(2));
		const [booking] = await t.query(api.booking.hostBookings.listUpcoming, {});
		expect(booking).toMatchObject({ guestName: 'Grace Guest', guestEmail: 'guest@example.com' });

		mockUserId = 'host-B';
		await expect(
			t.mutation(api.booking.hostBookings.cancel, { bookingId: booking!._id })
		).rejects.toThrow(/not found/i);
		expect(await t.query(api.booking.hostBookings.listUpcoming, {})).toEqual([]);

		mockUserId = 'host-A';
		await t.mutation(api.booking.hostBookings.cancel, { bookingId: booking!._id });
		expect(await t.query(api.booking.hostBookings.listUpcoming, {})).toEqual([]);
	});

	it('offers the next open times for the composer, skipping booked ones', async () => {
		const t = await setup();
		await createPage(t);
		const before = await t.query(api.booking.hostBookings.availabilitySnippet, {});
		expect(before?.slots).toHaveLength(5);
		expect(before?.url).toMatch(/\/book\/ada\/intro$/);
		await reserve(t, before!.slots[0]!);
		const after = await t.query(api.booking.hostBookings.availabilitySnippet, {});
		expect(after?.slots).not.toContain(before!.slots[0]);
	});
});

describe('HTTP routes', () => {
	it('books through the public route and swallows a honeypot hit', async () => {
		const t = await setup();
		await createPage(t);
		const start = tenOClockInDays(2);
		const post = (body: Record<string, unknown>) =>
			t.fetch('/booking/book/ada', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

		const bot = await post({
			type: 'intro',
			start,
			name: 'Bot',
			email: 'bot@example.com',
			website: 'https://spam.example.com',
		});
		expect(bot.status).toBe(200);
		expect(await t.run((ctx) => ctx.db.query('bookings').collect())).toEqual([]);

		const bad = await post({ type: 'intro', start: 'soon', name: 'Grace', email: 'g@example.com' });
		expect(bad.status).toBe(400);

		const ok = await post({
			type: 'intro',
			start,
			name: 'Grace',
			email: 'grace@example.com',
			timeZone: 'Europe/Berlin',
		});
		expect(ok.status).toBe(200);
		const taken = await post({ type: 'intro', start, name: 'Hal', email: 'hal@example.com' });
		expect(taken.status).toBe(409);

		const page = await t.fetch('/booking/page/ada?type=intro');
		expect(page.status).toBe(200);
		const missing = await t.fetch('/booking/page/nobody');
		expect(missing.status).toBe(404);
	});
});

describe('account export', () => {
	it('carries the host’s bookings without the token digest', async () => {
		const t = await setup();
		await createPage(t);
		await reserve(t, tenOClockInDays(2));
		const page = await t.run(async (ctx) => {
			const rows = await ctx.db.query('bookings').collect();
			return rows.map(({ manageTokenHash: _digest, ...rest }) => rest);
		});
		const exported = await t.query(internal.auth.accountExportQueries.listBookings, {
			userId: 'host-A',
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(exported.page).toEqual(page);
		const pages = await t.query(internal.auth.accountExportQueries.listBookingPages, {
			userId: 'host-A',
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(pages.page[0]).toMatchObject({ slug: 'ada', meetingTypes: [{ slug: 'intro' }] });
	});
});
