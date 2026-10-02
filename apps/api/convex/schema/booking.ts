import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Booking page — a member's public `/book/<slug>/<meeting>` page and the
 * bookings guests make on it (feature flag `calendar.booking`).
 *
 * Cascade contract: all three tables are the HOST's personal data, keyed by
 * their BetterAuth user id. Member erasure deletes every row (the guests'
 * names, addresses and notes go with the host's account); organization
 * deletion sweeps them with the tenant; the host's account export carries
 * them. Nothing else references these tables.
 */

const timeRange = v.object({ startMinute: v.number(), endMinute: v.number() });

export const bookingTables = {
	// One per member who set a booking page up. `weeklyHours` are the recurring
	// openings (several per weekday), `dateOverrides` replace a weekday's hours
	// on one local date (`ranges: []` is a day off). Minutes are wall clock in
	// `timeZone`.
	bookingProfiles: defineTable({
		userId: v.string(), // BetterAuth user id (the host)
		organizationId: v.string(),
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
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_user', ['userId'])
		.index('by_slug', ['slug']),

	// What a guest can book: `/book/<profile slug>/<slug>`.
	bookingMeetingTypes: defineTable({
		userId: v.string(), // BetterAuth user id (the host)
		organizationId: v.string(),
		slug: v.string(),
		title: v.string(),
		durationMinutes: v.number(),
		description: v.optional(v.string()),
		location: v.optional(v.string()),
		videoUrl: v.optional(v.string()),
		isActive: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_user_and_slug', ['userId', 'slug']),

	// One booked meeting. A reschedule moves the same row (same iCalendar UID,
	// higher sequence) so the guest's and host's calendars update in place; a
	// cancellation keeps the row as `cancelled` until the host's erasure.
	// `manageTokenHash` is the SHA-256 of the guest's cancel/reschedule link
	// token; the token itself is never stored.
	bookings: defineTable({
		userId: v.string(), // BetterAuth user id (the host)
		organizationId: v.string(),
		meetingTypeId: v.id('bookingMeetingTypes'),
		// SNAPSHOT — the meeting as it was booked; a later edit of the type does
		// not change a booking already made.
		title: v.string(),
		durationMinutes: v.number(),
		location: v.optional(v.string()),
		videoUrl: v.optional(v.string()),
		startAt: v.number(),
		endAt: v.number(),
		guestName: v.string(),
		guestEmail: v.string(), // lowercased
		guestNote: v.optional(v.string()),
		guestTimeZone: v.optional(v.string()),
		guestLocale: v.optional(v.string()),
		status: v.union(v.literal('confirmed'), v.literal('cancelled')),
		cancelledAt: v.optional(v.number()),
		cancelSource: v.optional(v.union(v.literal('host'), v.literal('guest'))),
		manageTokenHash: v.string(),
		icalUid: v.string(),
		icalSequence: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// Busy-time reads and the upcoming list: one host's bookings by start.
		.index('by_user_and_start', ['userId', 'startAt'])
		// The open-bookings-per-guest cap.
		.index('by_user_and_guest', ['userId', 'guestEmail'])
		.index('by_manage_token', ['manageTokenHash']),
};
