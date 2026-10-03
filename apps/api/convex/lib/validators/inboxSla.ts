import { v } from 'convex/values';

/**
 * Team Inbox response targets (SLA): the stored policy and the per-thread
 * clock columns. The clock rules live in `inbox/sla/clock.ts`; the business
 * hours arithmetic in `inbox/sla/businessHours.ts`.
 */

/** `business` counts only the opening hours below; `calendar` counts every minute. */
export const slaHoursModeValidator = v.union(v.literal('business'), v.literal('calendar'));

/**
 * One opening window: a weekday (0 = Sunday … 6 = Saturday) and its local
 * start and end in minutes from midnight, `start < end`, `end` up to 1440.
 */
export const slaBusinessHoursValidator = v.object({
	day: v.number(),
	start: v.number(),
	end: v.number(),
});

/** Field record of `inboxSlaPolicies`, shared with the save mutation. */
export const inboxSlaPolicyFields = {
	isEnabled: v.boolean(),
	// Targets, in minutes of the mode below.
	firstResponseMinutes: v.number(),
	nextResponseMinutes: v.number(),
	hoursMode: slaHoursModeValidator,
	// IANA zone the opening hours and holidays are read in.
	timeZone: v.string(),
	// At most one window per weekday; a weekday without one is closed.
	businessHours: v.array(slaBusinessHoursValidator),
	// Local dates (`YYYY-MM-DD`) on which the inbox is closed all day.
	holidays: v.array(v.string()),
	updatedAt: v.number(),
};

/**
 * The response clock a thread carries (`conversationThreads`). Every field is
 * optional: a thread written before targets existed, or while they are off,
 * carries none of them.
 *
 * Exactly one of `responseDueAt` (running) and `responsePausedRemainingMs`
 * (paused while snoozed or waiting on the customer) is set while a reply is
 * owed; both are absent otherwise. Only `inbox/threads/module.ts`,
 * `inbox/snooze.ts` and `inbox/sla/*` write them.
 */
export const conversationThreadSlaFields = {
	// When the owed reply is due. Indexed: the Overdue / Due soon slices, the
	// due order and the breach sweep all range over it.
	responseDueAt: v.optional(v.number()),
	responseDueKind: v.optional(v.union(v.literal('first'), v.literal('next'))),
	// When the customer message that started the clock arrived.
	responseClockStartedAt: v.optional(v.number()),
	// Business-time ms left when the clock was paused; zero or negative when it
	// was already overdue.
	responsePausedRemainingMs: v.optional(v.number()),
	// Set by the breach sweep once the overdue notice went out for this clock.
	slaBreachNotifiedAt: v.optional(v.number()),
	// AGGREGATED — when the team first replied, and the latest resolve.
	firstResponseAt: v.optional(v.number()),
	resolvedAt: v.optional(v.number()),
	// AGGREGATED — replies judged against a target: on time, and late.
	slaMetCount: v.optional(v.number()),
	slaMissedCount: v.optional(v.number()),
};
