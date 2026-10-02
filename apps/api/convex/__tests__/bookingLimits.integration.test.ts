/**
 * Booking page (`calendar.booking`): the limits that keep a public page usable
 * and its data clean, against the real schema.
 *
 *   - cancelled bookings never crowd the bounded busy-time read or the
 *     per-guest cap, so a pile of them cannot open a taken slot or lift the cap;
 *   - a guest name cannot carry a line break into the host's mail subject;
 *   - the public routes limit per IP and page, so a flood on one page (or on a
 *     made-up one) does not close another member's page while every caller
 *     shares the default `'unknown'` IP.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { enableFeatures } from './factories';
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
	};
});

const sentMail = vi.hoisted(() => [] as { subject: string; to: string }[]);
vi.mock('../systemMail', async (importOriginal) => ({
	...(await importOriginal<typeof import('../systemMail')>()),
	attemptSystemEmail: vi.fn(async (_ctx: unknown, args: { subject: string; to: string }) => {
		sentMail.push({ subject: args.subject, to: args.to });
		return { status: 'accepted' };
	}),
}));

const modules = import.meta.glob('../**/*.*s');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
	mockUserId = 'host-A';
	sentMail.length = 0;
});

async function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['calendar.booking']);
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('userProfiles', {
			authUserId: 'host-A',
			email: 'host-A@example.com',
			name: 'Ada Host',
			createdAt: now,
			updatedAt: now,
		});
	});
	await t.mutation(api.booking.settings.saveProfile, {
		slug: 'ada',
		timeZone: 'UTC',
		weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({
			weekday,
			startMinute: 9 * 60,
			endMinute: 17 * 60,
		})),
		dateOverrides: [],
		minimumNoticeMinutes: 0,
		horizonDays: 30,
		bufferMinutes: 0,
	});
	await t.mutation(api.booking.settings.saveMeetingType, {
		slug: 'intro',
		title: 'Intro call',
		durationMinutes: 30,
		isActive: true,
	});
	return t;
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
	guestName = 'Grace Guest'
) {
	return t.mutation(internal.booking.public.reserve, {
		slug: 'ada',
		typeSlug: 'intro',
		start,
		guestName,
		guestEmail,
		manageToken: `bk_${guestEmail}_${start}`,
	});
}

/** Rows a book-and-cancel loop would leave behind, written directly. */
async function insertCancelled(
	t: TestConvex<typeof schema>,
	count: number,
	row: { start: number; guestEmail: string }
) {
	await t.run(async (ctx) => {
		const type = await ctx.db.query('bookingMeetingTypes').first();
		const now = Date.now();
		for (let i = 0; i < count; i++) {
			await ctx.db.insert('bookings', {
				userId: 'host-A',
				organizationId: 'org-1',
				meetingTypeId: type!._id,
				title: 'Intro call',
				durationMinutes: 30,
				startAt: row.start,
				endAt: row.start + 30 * 60_000,
				guestName: 'Old Guest',
				guestEmail: row.guestEmail,
				status: 'cancelled',
				cancelledAt: now,
				cancelSource: 'guest',
				manageTokenHash: `digest-${i}`,
				icalUid: `uid-${i}@owlat`,
				icalSequence: 1,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

describe('cancelled bookings', () => {
	it('do not hide a confirmed booking from the busy-time read', async () => {
		const t = await setup();
		const start = tenOClockInDays(2);
		// More cancelled rows just before the slot than the busy read takes.
		await insertCancelled(t, 2001, { start: start - 30 * 60_000, guestEmail: 'old@example.com' });
		expect(await reserve(t, start)).toMatchObject({ ok: true });
		expect(await reserve(t, start, 'other@example.com')).toEqual({
			ok: false,
			reason: 'slot_taken',
		});
		const [first] = await t.query(api.booking.hostBookings.listUpcoming, {});
		expect(first).toMatchObject({ startAt: start, guestEmail: 'guest@example.com' });
	});

	it('do not count toward, or lift, one guest’s cap', async () => {
		const t = await setup();
		await insertCancelled(t, 250, { start: tenOClockInDays(1), guestEmail: 'same@example.com' });
		for (let i = 0; i < 3; i++) {
			expect(await reserve(t, tenOClockInDays(2 + i), 'same@example.com')).toMatchObject({
				ok: true,
			});
		}
		expect(await reserve(t, tenOClockInDays(6), 'same@example.com')).toEqual({
			ok: false,
			reason: 'too_many_bookings',
		});

		const [booking] = await t.query(api.booking.hostBookings.listUpcoming, {});
		await t.mutation(api.booking.hostBookings.cancel, { bookingId: booking!._id });
		expect(await reserve(t, tenOClockInDays(6), 'same@example.com')).toMatchObject({ ok: true });
	});
});

describe('guest input', () => {
	it('keeps a guest name to one line', async () => {
		const t = await setup();
		expect(
			await reserve(t, tenOClockInDays(2), 'guest@example.com', 'Grace\r\nBcc: victim@example.com')
		).toMatchObject({ ok: true });
		const row = await t.run((ctx) => ctx.db.query('bookings').first());
		expect(row?.guestName).toBe('Grace Bcc: victim@example.com');
	});

	it('keeps every invite subject to one header line', async () => {
		const t = await setup();
		const [type] = await t.run((ctx) => ctx.db.query('bookingMeetingTypes').collect());
		await t.mutation(api.booking.settings.saveMeetingType, {
			meetingTypeId: type!._id,
			slug: 'intro',
			title: 'Intro\r\nBcc: victim@example.com',
			durationMinutes: 30,
			isActive: true,
		});
		await reserve(t, tenOClockInDays(2));
		const row = await t.run((ctx) => ctx.db.query('bookings').first());
		await t.action(internal.booking.emails.send, { bookingId: row!._id, kind: 'confirmed' });
		expect(sentMail.map((mail) => mail.to).sort()).toEqual([
			'guest@example.com',
			'host-A@example.com',
		]);
		for (const mail of sentMail) expect(mail.subject).not.toMatch(/[\r\n]/);
	});
});

describe('public route limits', () => {
	it('keep a flood on one page from closing another', async () => {
		const t = await setup();
		const post = (slug: string, body: Record<string, unknown>) =>
			t.fetch(`/booking/book/${slug}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
		const flood = { type: 'intro', start: tenOClockInDays(2), name: 'Bot', email: 'b@example.com' };
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) statuses.push((await post('nobody', flood)).status);
		expect(statuses).toContain(429);

		const ok = await post('ada', {
			type: 'intro',
			start: tenOClockInDays(3),
			name: 'Grace',
			email: 'grace@example.com',
		});
		expect(ok.status).toBe(200);
	});
});
