/**
 * Booking page — the host's own settings: the page (slug, time zone, weekly
 * hours, date overrides, notice, horizon, buffer) and its meeting types.
 *
 * Every function reads and writes only rows keyed by the caller's user id, so
 * any member may run them on their own page and nobody can reach another's.
 */

import { v } from 'convex/values';
import { bookingMutation, bookingQuery } from './_helpers';
import {
	throwConflict,
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
} from '../_utils/errors';
import { isSafeRedirectUrl, validateStringLength } from '../lib/inputGuards';
import { loadLiveUserProfile } from '../lib/userProfiles';
import { BOOKING_LIMITS, isValidBookingSlug, suggestBookingSlug } from '@owlat/shared/booking';
import { assertAvailability, assertWholeNumber, bookingPageUrl, bookingSiteUrl } from './model';

const timeRange = v.object({ startMinute: v.number(), endMinute: v.number() });

/** Trim; an empty string reads as unset. */
function optionalText(value: string | undefined, max: number, field: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	validateStringLength(trimmed, max, field);
	return trimmed;
}

/**
 * The caller's booking page and meeting types, plus what the form needs to
 * start one: a suggested slug from their name. `profile` is `null` until the
 * first save.
 */
export const getMine = bookingQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		// authz: self-scope — reads only rows keyed by session.userId
		const profile = await ctx.db
			.query('bookingProfiles')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		const meetingTypes = await ctx.db
			.query('bookingMeetingTypes')
			.withIndex('by_user_and_slug', (q) => q.eq('userId', session.userId))
			.take(BOOKING_LIMITS.meetingTypesMax + 1);
		const user = await loadLiveUserProfile(ctx, session.userId);
		return {
			profile: profile
				? {
						slug: profile.slug,
						displayName: profile.displayName ?? null,
						timeZone: profile.timeZone,
						weeklyHours: profile.weeklyHours,
						dateOverrides: profile.dateOverrides,
						minimumNoticeMinutes: profile.minimumNoticeMinutes,
						horizonDays: profile.horizonDays,
						bufferMinutes: profile.bufferMinutes,
						pageUrl: bookingPageUrl(profile.slug),
					}
				: null,
			meetingTypes: meetingTypes
				.sort((a, b) => a.createdAt - b.createdAt)
				.map((type) => ({
					_id: type._id,
					slug: type.slug,
					title: type.title,
					durationMinutes: type.durationMinutes,
					description: type.description ?? null,
					location: type.location ?? null,
					videoUrl: type.videoUrl ?? null,
					isActive: type.isActive,
					url: profile ? bookingPageUrl(profile.slug, type.slug) : null,
				})),
			siteUrl: bookingSiteUrl(),
			suggestedSlug: suggestBookingSlug(user?.name ?? user?.email?.split('@')[0] ?? ''),
			defaultName: user?.name ?? null,
		};
	},
});

/** Create or update the caller's booking page. */
export const saveProfile = bookingMutation({
	args: {
		slug: v.string(),
		displayName: v.optional(v.string()),
		timeZone: v.string(),
		weeklyHours: v.array(
			v.object({ weekday: v.number(), startMinute: v.number(), endMinute: v.number() })
		),
		dateOverrides: v.array(v.object({ date: v.string(), ranges: v.array(timeRange) })),
		minimumNoticeMinutes: v.number(),
		horizonDays: v.number(),
		bufferMinutes: v.number(),
	},
	handler: async (ctx, args, session) => {
		// authz: self-scope — the row written is keyed by session.userId
		const slug = args.slug.trim().toLowerCase();
		if (!isValidBookingSlug(slug)) throwInvalidInput('Invalid link name', { field: 'slug' });
		const displayName = optionalText(
			args.displayName,
			BOOKING_LIMITS.displayNameMaxLength,
			'displayName'
		);
		assertAvailability(args);

		const taken = await ctx.db
			.query('bookingProfiles')
			.withIndex('by_slug', (q) => q.eq('slug', slug))
			.first();
		if (taken && taken.userId !== session.userId) {
			throwConflict('That link name is taken', { field: 'slug', code: 'SLUG_TAKEN' });
		}

		const existing = await ctx.db
			.query('bookingProfiles')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		const now = Date.now();
		const data = {
			slug,
			displayName,
			timeZone: args.timeZone,
			weeklyHours: [...args.weeklyHours].sort(
				(a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute
			),
			dateOverrides: [...args.dateOverrides].sort((a, b) => a.date.localeCompare(b.date)),
			minimumNoticeMinutes: args.minimumNoticeMinutes,
			horizonDays: args.horizonDays,
			bufferMinutes: args.bufferMinutes,
			updatedAt: now,
		};
		if (existing) {
			await ctx.db.patch(existing._id, data);
			return existing._id;
		}
		return ctx.db.insert('bookingProfiles', {
			...data,
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			createdAt: now,
		});
	},
});

/** Create (no `meetingTypeId`) or update one of the caller's meeting types. */
export const saveMeetingType = bookingMutation({
	args: {
		meetingTypeId: v.optional(v.id('bookingMeetingTypes')),
		slug: v.string(),
		title: v.string(),
		durationMinutes: v.number(),
		description: v.optional(v.string()),
		location: v.optional(v.string()),
		videoUrl: v.optional(v.string()),
		isActive: v.boolean(),
	},
	handler: async (ctx, args, session) => {
		// authz: self-scope — the row written is keyed by session.userId and an
		// existing row is checked to be the caller's
		const profile = await ctx.db
			.query('bookingProfiles')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		if (!profile) throwInvalidState('Set up your booking page first');

		const slug = args.slug.trim().toLowerCase();
		if (!isValidBookingSlug(slug)) throwInvalidInput('Invalid link name', { field: 'slug' });
		const title = args.title.trim();
		if (!title) throwInvalidInput('Title required', { field: 'title' });
		validateStringLength(title, BOOKING_LIMITS.titleMaxLength, 'title');
		assertWholeNumber(
			args.durationMinutes,
			BOOKING_LIMITS.durationMinMinutes,
			BOOKING_LIMITS.durationMaxMinutes,
			'durationMinutes'
		);
		const description = optionalText(
			args.description,
			BOOKING_LIMITS.descriptionMaxLength,
			'description'
		);
		const location = optionalText(args.location, BOOKING_LIMITS.locationMaxLength, 'location');
		const videoUrl = optionalText(args.videoUrl, BOOKING_LIMITS.videoUrlMaxLength, 'videoUrl');
		if (videoUrl && !isSafeRedirectUrl(videoUrl)) {
			throwInvalidInput('The video link must be an http or https address', { field: 'videoUrl' });
		}

		const sameSlug = await ctx.db
			.query('bookingMeetingTypes')
			.withIndex('by_user_and_slug', (q) => q.eq('userId', session.userId).eq('slug', slug))
			.first();
		if (sameSlug && sameSlug._id !== args.meetingTypeId) {
			throwConflict('You already use that link name', { field: 'slug', code: 'SLUG_TAKEN' });
		}

		const now = Date.now();
		const data = {
			slug,
			title,
			durationMinutes: args.durationMinutes,
			description,
			location,
			videoUrl,
			isActive: args.isActive,
			updatedAt: now,
		};
		if (args.meetingTypeId) {
			const existing = await ctx.db.get(args.meetingTypeId);
			if (!existing || existing.userId !== session.userId) throwNotFound('Meeting type');
			await ctx.db.patch(existing._id, data);
			return existing._id;
		}
		const count = (
			await ctx.db
				.query('bookingMeetingTypes')
				.withIndex('by_user_and_slug', (q) => q.eq('userId', session.userId))
				.take(BOOKING_LIMITS.meetingTypesMax)
		).length;
		if (count >= BOOKING_LIMITS.meetingTypesMax) {
			throwInvalidState(`At most ${BOOKING_LIMITS.meetingTypesMax} meeting types`);
		}
		return ctx.db.insert('bookingMeetingTypes', {
			...data,
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			createdAt: now,
		});
	},
});

/**
 * Delete one of the caller's meeting types. Bookings already made keep their
 * own copy of the meeting and stay as they are.
 */
export const deleteMeetingType = bookingMutation({
	args: { meetingTypeId: v.id('bookingMeetingTypes') },
	handler: async (ctx, args, session) => {
		// authz: self-scope — only a row keyed by session.userId is deleted
		const existing = await ctx.db.get(args.meetingTypeId);
		if (!existing || existing.userId !== session.userId) throwNotFound('Meeting type');
		await ctx.db.delete(existing._id);
	},
});
