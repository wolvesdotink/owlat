/**
 * Booking page — what the host does with bookings: the upcoming list, a
 * host-side cancellation, and the open times the composer's "Insert
 * availability" puts into a message.
 *
 * Self-scoped like `booking/settings.ts`: only rows keyed by the caller's user
 * id are read or written.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { bookingMutation, bookingQuery } from './_helpers';
import { throwNotFound } from '../_utils/errors';
import { bookingPageUrl, loadBusy, rulesOf } from './model';
import { computeSlots } from './slots';

const HOUR_MS = 60 * 60 * 1000;
/** How many upcoming bookings the list shows. */
const UPCOMING_LIMIT = 100;
/** How many open times "Insert availability" offers. */
const SNIPPET_SLOTS = 5;

/** The caller's confirmed bookings that have not ended yet, soonest first. */
export const listUpcoming = bookingQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		// authz: self-scope — reads only bookings keyed by session.userId
		const now = Date.now();
		// A meeting that started up to a day ago may still be running.
		const rows = await ctx.db
			.query('bookings')
			.withIndex('by_user_and_status_and_start', (q) =>
				q
					.eq('userId', session.userId)
					.eq('status', 'confirmed')
					.gte('startAt', now - 24 * HOUR_MS)
			)
			.take(UPCOMING_LIMIT * 2); // bounded: the list shows at most UPCOMING_LIMIT
		return rows
			.filter((row) => row.endAt > now)
			.slice(0, UPCOMING_LIMIT)
			.map((row) => ({
				_id: row._id,
				title: row.title,
				startAt: row.startAt,
				endAt: row.endAt,
				guestName: row.guestName,
				guestEmail: row.guestEmail,
				guestNote: row.guestNote ?? null,
				guestTimeZone: row.guestTimeZone ?? null,
				location: row.location ?? null,
				videoUrl: row.videoUrl ?? null,
			}));
	},
});

/** Cancel one of the caller's bookings; the guest gets the cancellation. */
export const cancel = bookingMutation({
	args: { bookingId: v.id('bookings') },
	handler: async (ctx, args, session) => {
		// authz: self-scope — only a booking keyed by session.userId is cancelled
		const booking = await ctx.db.get(args.bookingId);
		if (!booking || booking.userId !== session.userId) throwNotFound('Booking');
		if (booking.status === 'cancelled') return;
		const now = Date.now();
		const sequence = booking.icalSequence + 1;
		await ctx.db.patch(booking._id, {
			status: 'cancelled',
			cancelledAt: now,
			cancelSource: 'host',
			icalSequence: sequence,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.booking.emails.send, {
			bookingId: booking._id,
			kind: 'cancelled',
			sequence,
		});
	},
});

/**
 * The page link and the next open times of one meeting type (the first active
 * one when none is named), for "Insert availability" in the composer. `null`
 * when the caller has no page or no active meeting type.
 */
export const availabilitySnippet = bookingQuery({
	args: { meetingTypeId: v.optional(v.id('bookingMeetingTypes')) },
	handler: async (ctx, args, session) => {
		// authz: self-scope — reads only the caller's own page and bookings
		const profile = await ctx.db
			.query('bookingProfiles')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		if (!profile) return null;
		const types = await ctx.db
			.query('bookingMeetingTypes')
			.withIndex('by_user_and_slug', (q) => q.eq('userId', session.userId))
			.take(50); // bounded: BOOKING_LIMITS.meetingTypesMax
		const active = types.filter((type) => type.isActive).sort((a, b) => a.createdAt - b.createdAt);
		const type = args.meetingTypeId
			? active.find((candidate) => candidate._id === args.meetingTypeId)
			: active[0];
		if (!type) return null;

		const now = Date.now();
		const until = now + profile.horizonDays * 24 * HOUR_MS;
		const busy = await loadBusy(ctx, {
			userId: session.userId,
			from: now,
			until,
			bufferMinutes: profile.bufferMinutes,
		});
		const slots = computeSlots(rulesOf(profile), {
			durationMinutes: type.durationMinutes,
			busy,
			now,
			limit: SNIPPET_SLOTS,
		});
		return {
			title: type.title,
			durationMinutes: type.durationMinutes,
			timeZone: profile.timeZone,
			url: bookingPageUrl(profile.slug, type.slug),
			slots,
		};
	},
});
