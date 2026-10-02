import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { requireSelf } from '../lib/sessionOrganization';

// Booking-page resources of "Export my data", next to accountExportQueries.ts.

/**
 * The member's booking page: one row with its hours and the meeting types it
 * offers (at most `BOOKING_LIMITS.meetingTypesMax`), or none.
 */
export const listBookingPages = internalQuery({
	args: { userId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const result = await ctx.db
			.query('bookingProfiles')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.paginate(args.paginationOpts);
		const page = await Promise.all(
			result.page.map(async (profile) => ({
				...profile,
				meetingTypes: await ctx.db
					.query('bookingMeetingTypes')
					.withIndex('by_user_and_slug', (q) => q.eq('userId', args.userId))
					.take(50), // bounded: BOOKING_LIMITS.meetingTypesMax
			}))
		);
		return { ...result, page };
	},
});

/** Meetings guests booked with the member, without the manage-link digest. */
export const listBookings = internalQuery({
	args: { userId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const result = await ctx.db
			.query('bookings')
			.withIndex('by_user_and_start', (q) => q.eq('userId', args.userId))
			.paginate(args.paginationOpts);
		return {
			...result,
			page: result.page.map(({ manageTokenHash: _digest, ...booking }) => booking),
		};
	},
});
