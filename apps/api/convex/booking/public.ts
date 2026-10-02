/**
 * Booking page — the guest side, behind the public HTTP routes in
 * `booking/publicHttp.ts`. Internal only: the routes own the per-IP rate
 * limits, the honeypot and the token minting, and call in here.
 *
 * While `calendar.booking` is off, or the host's account is being deleted,
 * every read answers "not found" and every write refuses, so a page never
 * outlives the feature or the person.
 *
 * No double booking: `reserve` and `reschedule` read the host's bookings
 * around the requested slot and insert or move a row in that same index range
 * in one transaction. Two guests racing for one slot conflict, Convex retries
 * the loser, and the retry sees the winner's row and answers `slot_taken`.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { loadLiveUserProfile } from '../lib/userProfiles';
import { rateLimiter } from '../lib/rateLimiter';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';
import { BOOKING_LIMITS } from '@owlat/shared/booking';
import { randomToken } from '../lib/randomToken';
import { hashManageToken, hostDisplayName, isKnownTimeZone, loadBusy, rulesOf } from './model';
import { bookableWindow, computeSlots, isSlotOpen } from './slots';

type ReadCtx = QueryCtx | MutationCtx;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The widest window one page read computes slots for. */
const MAX_WINDOW_MS = 42 * DAY_MS;

/** A live host's page, or `null` (flag off, no page, account going away). */
async function loadPage(ctx: ReadCtx, slug: string) {
	if (!(await isFeatureEnabled(ctx, 'calendar.booking'))) return null;
	const profile = await ctx.db
		.query('bookingProfiles')
		.withIndex('by_slug', (q) => q.eq('slug', slug.toLowerCase()))
		.first();
	if (!profile) return null;
	const user = await loadLiveUserProfile(ctx, profile.userId);
	if (!user) return null;
	return { profile, user };
}

async function loadActiveType(ctx: ReadCtx, userId: string, slug: string) {
	const type = await ctx.db
		.query('bookingMeetingTypes')
		.withIndex('by_user_and_slug', (q) => q.eq('userId', userId).eq('slug', slug.toLowerCase()))
		.first();
	return type?.isActive ? type : null;
}

/** Slots for a page read, the window clamped to the bookable range. */
async function slotsFor(
	ctx: ReadCtx,
	profile: Doc<'bookingProfiles'>,
	durationMinutes: number,
	window: { from?: number; until?: number },
	exclude?: Doc<'bookings'>['_id']
) {
	const now = Date.now();
	const bounds = bookableWindow(profile, now);
	const from = Math.max(bounds.earliest, window.from ?? bounds.earliest);
	const until = Math.min(
		bounds.latest + 1,
		window.until ?? from + MAX_WINDOW_MS,
		from + MAX_WINDOW_MS
	);
	const busy = await loadBusy(ctx, {
		userId: profile.userId,
		from,
		until,
		bufferMinutes: profile.bufferMinutes,
		exclude,
	});
	return {
		slots: computeSlots(rulesOf(profile), { durationMinutes, busy, now, from, until }),
		earliest: bounds.earliest,
		latest: bounds.latest,
	};
}

function publicType(type: Doc<'bookingMeetingTypes'>) {
	return {
		slug: type.slug,
		title: type.title,
		durationMinutes: type.durationMinutes,
		description: type.description ?? null,
		location: type.location ?? null,
		hasVideoLink: Boolean(type.videoUrl),
	};
}

/**
 * What the public page renders: the host and their active meeting types, or —
 * with `typeSlug` — that one meeting and its open times in `[from, until)`.
 * The video link is not shown before a booking; the confirmation carries it.
 */
export const getPage = internalQuery({
	args: {
		slug: v.string(),
		typeSlug: v.optional(v.string()),
		from: v.optional(v.number()),
		until: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const page = await loadPage(ctx, args.slug);
		if (!page) return null;
		const host = {
			name: hostDisplayName(page.profile, page.user),
			image: page.user.image ?? null,
			timeZone: page.profile.timeZone,
		};
		if (!args.typeSlug) {
			const types = await ctx.db
				.query('bookingMeetingTypes')
				.withIndex('by_user_and_slug', (q) => q.eq('userId', page.profile.userId))
				.take(50); // bounded: BOOKING_LIMITS.meetingTypesMax
			return {
				host,
				meetingTypes: types
					.filter((type) => type.isActive)
					.sort((a, b) => a.createdAt - b.createdAt)
					.map(publicType),
			};
		}
		const type = await loadActiveType(ctx, page.profile.userId, args.typeSlug);
		if (!type) return null;
		const open = await slotsFor(ctx, page.profile, type.durationMinutes, args);
		return { host, meetingType: publicType(type), ...open };
	},
});

const guestArgs = {
	guestName: v.string(),
	guestEmail: v.string(),
	guestNote: v.optional(v.string()),
	guestTimeZone: v.optional(v.string()),
	guestLocale: v.optional(v.string()),
};

type ReserveOutcome =
	| { ok: true; booking: { title: string; startAt: number; endAt: number; hostName: string } }
	| { ok: false; reason: string };

function cleanGuest(args: {
	guestName: string;
	guestEmail: string;
	guestNote?: string;
	guestTimeZone?: string;
	guestLocale?: string;
}) {
	const guestName = args.guestName.trim();
	const guestEmail = normalizeEmail(args.guestEmail);
	const guestNote = args.guestNote?.trim() || undefined;
	if (!guestName || guestName.length > BOOKING_LIMITS.guestNameMaxLength) return null;
	if (!isValidEmail(guestEmail)) return null;
	if (guestNote && guestNote.length > BOOKING_LIMITS.guestNoteMaxLength) return null;
	return {
		guestName,
		guestEmail,
		guestNote,
		guestTimeZone:
			args.guestTimeZone && isKnownTimeZone(args.guestTimeZone) ? args.guestTimeZone : undefined,
		guestLocale: args.guestLocale && args.guestLocale.length <= 16 ? args.guestLocale : undefined,
	};
}

/**
 * Book `start` on a host's meeting type for a guest. Re-checks the slot
 * against the host's rules and bookings in this transaction, caps the guest's
 * open bookings with this host and the host's bookings per hour, then stores
 * the booking and schedules the invites. Only the digest of the guest's
 * manage token is stored; the token itself rides to the mail action, which
 * puts it in the guest's links.
 */
export const reserve = internalMutation({
	args: {
		slug: v.string(),
		typeSlug: v.string(),
		start: v.number(),
		...guestArgs,
		manageToken: v.string(),
	},
	handler: async (ctx, args): Promise<ReserveOutcome> => {
		const page = await loadPage(ctx, args.slug);
		if (!page) return { ok: false, reason: 'not_found' };
		const type = await loadActiveType(ctx, page.profile.userId, args.typeSlug);
		if (!type) return { ok: false, reason: 'not_found' };
		const guest = cleanGuest(args);
		if (!guest) return { ok: false, reason: 'invalid_guest' };

		const now = Date.now();
		const existing = await ctx.db
			.query('bookings')
			.withIndex('by_user_and_guest', (q) =>
				q.eq('userId', page.profile.userId).eq('guestEmail', guest.guestEmail)
			)
			.take(200); // bounded: one guest's bookings with one host
		const open = existing.filter((row) => row.status === 'confirmed' && row.endAt > now);
		if (open.length >= BOOKING_LIMITS.openBookingsPerGuest) {
			return { ok: false, reason: 'too_many_bookings' };
		}

		const busy = await loadBusy(ctx, {
			userId: page.profile.userId,
			from: args.start,
			until: args.start + type.durationMinutes * 60_000,
			bufferMinutes: page.profile.bufferMinutes,
		});
		if (
			!isSlotOpen(rulesOf(page.profile), {
				durationMinutes: type.durationMinutes,
				busy,
				now,
				start: args.start,
			})
		) {
			return { ok: false, reason: 'slot_taken' };
		}

		const hostLimit = await rateLimiter.limit(ctx, 'bookingPerHost', {
			key: page.profile.userId,
		});
		if (!hostLimit.ok) return { ok: false, reason: 'rate_limited' };

		const bookingId = await ctx.db.insert('bookings', {
			userId: page.profile.userId,
			organizationId: page.profile.organizationId,
			meetingTypeId: type._id,
			title: type.title,
			durationMinutes: type.durationMinutes,
			location: type.location,
			videoUrl: type.videoUrl,
			startAt: args.start,
			endAt: args.start + type.durationMinutes * 60_000,
			...guest,
			status: 'confirmed',
			manageTokenHash: await hashManageToken(args.manageToken),
			icalUid: `${randomToken(24)}@owlat`,
			icalSequence: 0,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.booking.emails.send, {
			bookingId,
			kind: 'confirmed',
			manageToken: args.manageToken,
		});
		return {
			ok: true,
			booking: {
				title: type.title,
				startAt: args.start,
				endAt: args.start + type.durationMinutes * 60_000,
				hostName: hostDisplayName(page.profile, page.user),
			},
		};
	},
});

/** A booking by its manage token digest, while its host's page still exists. */
async function loadManaged(ctx: ReadCtx, manageTokenHash: string) {
	const booking = await ctx.db
		.query('bookings')
		.withIndex('by_manage_token', (q) => q.eq('manageTokenHash', manageTokenHash))
		.first();
	if (!booking) return null;
	if (!(await isFeatureEnabled(ctx, 'calendar.booking'))) return null;
	const profile = await ctx.db
		.query('bookingProfiles')
		.withIndex('by_user', (q) => q.eq('userId', booking.userId))
		.first();
	const user = await loadLiveUserProfile(ctx, booking.userId);
	if (!profile || !user) return null;
	return { booking, profile, user };
}

/**
 * The guest's view of their booking, and — while it can still be moved — the
 * open times to move it to in `[from, until)` (its own slot counts as free).
 */
export const getManaged = internalQuery({
	args: {
		manageTokenHash: v.string(),
		from: v.optional(v.number()),
		until: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const managed = await loadManaged(ctx, args.manageTokenHash);
		if (!managed) return null;
		const { booking, profile, user } = managed;
		const isChangeable = booking.status === 'confirmed' && booking.startAt > Date.now();
		const type = isChangeable ? await ctx.db.get(booking.meetingTypeId) : null;
		const open =
			type?.isActive && isChangeable
				? await slotsFor(ctx, profile, booking.durationMinutes, args, booking._id)
				: null;
		return {
			booking: {
				title: booking.title,
				startAt: booking.startAt,
				endAt: booking.endAt,
				status: booking.status,
				guestName: booking.guestName,
				location: booking.location ?? null,
				hasVideoLink: Boolean(booking.videoUrl),
			},
			host: { name: hostDisplayName(profile, user), timeZone: profile.timeZone },
			isChangeable,
			reschedule: open,
		};
	},
});

/** The guest cancels. Idempotent: a second cancel changes nothing. */
export const cancelByToken = internalMutation({
	args: { manageTokenHash: v.string() },
	handler: async (ctx, args): Promise<{ ok: true } | { ok: false; reason: string }> => {
		const managed = await loadManaged(ctx, args.manageTokenHash);
		if (!managed) return { ok: false, reason: 'not_found' };
		const { booking } = managed;
		if (booking.status === 'cancelled') return { ok: true };
		const now = Date.now();
		if (booking.startAt <= now) return { ok: false, reason: 'already_started' };
		await ctx.db.patch(booking._id, {
			status: 'cancelled',
			cancelledAt: now,
			cancelSource: 'guest',
			icalSequence: booking.icalSequence + 1,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.booking.emails.send, {
			bookingId: booking._id,
			kind: 'cancelled',
		});
		return { ok: true };
	},
});

/**
 * The guest moves the booking to `start`. Same checks as `reserve`, with the
 * booking's own slot counted as free. The row keeps its iCalendar UID with a
 * higher sequence, so calendars move the event, and the manage token is
 * replaced: the newest mail holds the only working link.
 */
export const rescheduleByToken = internalMutation({
	args: {
		manageTokenHash: v.string(),
		start: v.number(),
		nextManageToken: v.string(),
	},
	handler: async (
		ctx,
		args
	): Promise<{ ok: true; startAt: number; endAt: number } | { ok: false; reason: string }> => {
		const managed = await loadManaged(ctx, args.manageTokenHash);
		if (!managed) return { ok: false, reason: 'not_found' };
		const { booking, profile } = managed;
		const now = Date.now();
		if (booking.status !== 'confirmed' || booking.startAt <= now) {
			return { ok: false, reason: 'not_changeable' };
		}
		const type = await ctx.db.get(booking.meetingTypeId);
		if (!type?.isActive) return { ok: false, reason: 'not_changeable' };
		const durationMs = booking.durationMinutes * 60_000;
		const busy = await loadBusy(ctx, {
			userId: booking.userId,
			from: args.start,
			until: args.start + durationMs,
			bufferMinutes: profile.bufferMinutes,
			exclude: booking._id,
		});
		if (
			!isSlotOpen(rulesOf(profile), {
				durationMinutes: booking.durationMinutes,
				busy,
				now,
				start: args.start,
			})
		) {
			return { ok: false, reason: 'slot_taken' };
		}
		const hostLimit = await rateLimiter.limit(ctx, 'bookingPerHost', { key: booking.userId });
		if (!hostLimit.ok) return { ok: false, reason: 'rate_limited' };

		await ctx.db.patch(booking._id, {
			startAt: args.start,
			endAt: args.start + durationMs,
			icalSequence: booking.icalSequence + 1,
			manageTokenHash: await hashManageToken(args.nextManageToken),
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.booking.emails.send, {
			bookingId: booking._id,
			kind: 'rescheduled',
			manageToken: args.nextManageToken,
		});
		return { ok: true, startAt: args.start, endAt: args.start + durationMs };
	},
});

/** Everything the invite mails need, read once by the mail action. */
export const loadForEmail = internalQuery({
	args: { bookingId: v.id('bookings') },
	handler: async (ctx, args) => {
		const booking = await ctx.db.get(args.bookingId);
		if (!booking) return null;
		const profile = await ctx.db
			.query('bookingProfiles')
			.withIndex('by_user', (q) => q.eq('userId', booking.userId))
			.first();
		const user = await loadLiveUserProfile(ctx, booking.userId);
		if (!user) return null;
		return {
			booking,
			host: {
				name: profile ? hostDisplayName(profile, user) : (user.name ?? user.email),
				email: user.email,
				locale: user.locale,
				timeZone: profile?.timeZone ?? 'UTC',
			},
		};
	},
});
