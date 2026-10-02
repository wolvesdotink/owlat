/**
 * Booking page (`calendar.booking`): the limits that keep a public page usable
 * and its data clean, against the real schema.
 *
 *   - cancelled bookings never crowd the bounded busy-time read or the
 *     per-guest cap, so a pile of them cannot open a taken slot or lift the cap;
 *   - a guest name cannot carry a line break into the host's mail subject;
 *   - the public routes limit per IP and page, so a flood on one page (or on a
 *     made-up one) does not close another member's page while every caller
 *     shares the default `'unknown'` IP, and a page or manage link spelled
 *     another way (capitals, percent escapes) does not reach the page with a
 *     bucket of its own;
 *   - date overrides already over are dropped on save, so they never fill the
 *     override cap;
 *   - an invite mail overtaken by a later change (a cancel, a move) sends
 *     nothing, so a late confirmation cannot bring a cancelled event back.
 */

import { convexTest, type TestConvex } from 'convex-test';
import type { FunctionArgs } from 'convex/server';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { enableFeatures } from './factories';
import { hashManageToken } from '../booking/model';
import type * as SessionOrganization from '../lib/sessionOrganization';
import type * as SystemMail from '../systemMail';

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

const sentMail = vi.hoisted(() => [] as { subject: string; to: string; ics: string }[]);
vi.mock('../systemMail', async (importOriginal) => ({
	...(await importOriginal<typeof SystemMail>()),
	attemptSystemEmail: vi.fn(
		async (
			_ctx: unknown,
			args: { subject: string; to: string; attachments?: { contentBase64: string }[] }
		) => {
			const ics = Buffer.from(args.attachments?.[0]?.contentBase64 ?? '', 'base64').toString();
			sentMail.push({ subject: args.subject, to: args.to, ics });
			return { status: 'accepted' };
		}
	),
}));

const modules = import.meta.glob('../**/*.*s');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
	mockUserId = 'host-A';
	sentMail.length = 0;
});

// Every booking change queues invite mail on a real timer. Finish it before the
// next test clears `sentMail`, or it lands among that test's mail.
const started: TestConvex<typeof schema>[] = [];
afterEach(async () => {
	for (const t of started.splice(0)) await t.finishAllScheduledFunctions(() => {});
});

async function setup() {
	const t = convexTest(schema, modules);
	started.push(t);
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
		await t.action(internal.booking.emails.send, {
			bookingId: row!._id,
			kind: 'confirmed',
			sequence: 0,
		});
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

describe('public route spelling', () => {
	const post = (t: TestConvex<typeof schema>, path: string, body: Record<string, unknown>) =>
		t.fetch(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

	it('answers only to the page slug as stored', async () => {
		const t = await setup();
		expect((await t.fetch('/booking/page/ada?type=intro')).status).toBe(200);
		for (const variant of ['ADA', 'Ada', '%61da', 'ad%61']) {
			expect((await t.fetch(`/booking/page/${variant}?type=intro`)).status).toBe(404);
			const booked = await post(t, `/booking/book/${variant}`, {
				type: 'intro',
				start: tenOClockInDays(2),
				name: 'Grace',
				email: 'grace@example.com',
			});
			expect(booked.status).toBe(404);
		}
		expect(await t.run((ctx) => ctx.db.query('bookings').collect())).toEqual([]);
	});

	it('answers only to the manage token as minted', async () => {
		const t = await setup();
		const token = `bk_${'a'.repeat(40)}`;
		await t.mutation(internal.booking.public.reserve, {
			slug: 'ada',
			typeSlug: 'intro',
			start: tenOClockInDays(2),
			guestName: 'Grace',
			guestEmail: 'grace@example.com',
			manageToken: token,
		});
		expect((await t.fetch(`/booking/manage/${token}`)).status).toBe(200);
		const escaped = token.replace(/a$/, '%61');
		expect((await t.fetch(`/booking/manage/${escaped}`)).status).toBe(404);
		expect((await post(t, `/booking/cancel/${escaped}`, {})).status).toBe(404);
		const [row] = await t.run((ctx) => ctx.db.query('bookings').collect());
		expect(row?.status).toBe('confirmed');
		expect((await post(t, `/booking/cancel/${token}`, {})).status).toBe(200);
	});
});

describe('date overrides', () => {
	it('drops the ones already over when the page is saved', async () => {
		const t = await setup();
		const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
		const past = Array.from({ length: 120 }, (_, i) => ({
			date: dateKey(Date.now() - (i + 2) * DAY),
			ranges: [],
		}));
		const upcoming = { date: dateKey(Date.now() + 3 * DAY), ranges: [] };
		await t.mutation(api.booking.settings.saveProfile, {
			slug: 'ada',
			timeZone: 'UTC',
			weeklyHours: [{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }],
			dateOverrides: [...past, upcoming],
			minimumNoticeMinutes: 0,
			horizonDays: 30,
			bufferMinutes: 0,
		});
		const mine = await t.query(api.booking.settings.getMine, {});
		expect(mine.profile?.dateOverrides).toEqual([upcoming]);
	});
});

describe('invite mail order', () => {
	// Hold the queued mails so each test runs them itself, in the order it picks.
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** The arguments of every queued invite mail, oldest first. */
	async function queuedMail(t: TestConvex<typeof schema>) {
		const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		return jobs
			.filter((job) => job.name.includes('booking/emails'))
			.map((job) => job.args[0] as FunctionArgs<typeof internal.booking.emails.send>);
	}
	const methods = () => sentMail.map((mail) => /^METHOD:(\w+)/m.exec(mail.ics)?.[1]);

	it('drops a confirmation the host cancelled before it went out', async () => {
		const t = await setup();
		await reserve(t, tenOClockInDays(2));
		const [booking] = await t.query(api.booking.hostBookings.listUpcoming, {});
		await t.mutation(api.booking.hostBookings.cancel, { bookingId: booking!._id });
		const [confirmed, cancelled] = await queuedMail(t);
		expect(confirmed).toMatchObject({ kind: 'confirmed' });
		expect(cancelled).toMatchObject({ kind: 'cancelled' });

		await t.action(internal.booking.emails.send, confirmed!);
		expect(sentMail).toEqual([]);
		await t.action(internal.booking.emails.send, cancelled!);
		expect(methods()).toEqual(['CANCEL', 'CANCEL']);
		for (const mail of sentMail) expect(mail.ics).toMatch(/^SEQUENCE:1\r$/m);
	});

	it('drops a confirmation the guest moved before it went out', async () => {
		const t = await setup();
		const token = `bk_${'b'.repeat(40)}`;
		await t.mutation(internal.booking.public.reserve, {
			slug: 'ada',
			typeSlug: 'intro',
			start: tenOClockInDays(2),
			guestName: 'Grace',
			guestEmail: 'grace@example.com',
			manageToken: token,
		});
		await t.mutation(internal.booking.public.rescheduleByToken, {
			manageTokenHash: await hashManageToken(token),
			start: tenOClockInDays(3),
			nextManageToken: `bk_${'c'.repeat(40)}`,
		});
		const [confirmed, moved] = await queuedMail(t);

		await t.action(internal.booking.emails.send, confirmed!);
		expect(sentMail).toEqual([]);
		await t.action(internal.booking.emails.send, moved!);
		expect(methods()).toEqual(['REQUEST', 'REQUEST']);
		for (const mail of sentMail) expect(mail.ics).toMatch(/^SEQUENCE:1\r$/m);
	});
});

describe('queued mail', { shuffle: false }, () => {
	// The two tests run in this order: the first leaves mail queued when it
	// returns, the second checks that all of it ran before it started. No retry,
	// so a second attempt cannot pass once the stray mail has gone out.
	let previous: TestConvex<typeof schema> | undefined;

	it('returns with invite mail still queued', async () => {
		const t = await setup();
		previous = t;
		await reserve(t, tenOClockInDays(2));
		const [booking] = await t.query(api.booking.hostBookings.listUpcoming, {});
		await t.mutation(api.booking.hostBookings.cancel, { bookingId: booking!._id });
	});

	it('finds the previous test’s mail sent before it starts', { retry: 0 }, async () => {
		expect(previous).toBeDefined();
		const jobs = await previous!.run((ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(jobs.map((job) => job.state.kind)).toEqual(['success', 'success']);
		await previous!.finishAllScheduledFunctions(() => {});
		expect(sentMail).toEqual([]);
	});
});
