import { v } from 'convex/values';

/**
 * Team Inbox auto-close: the stored policy and the per-thread columns. The
 * eligibility and deadline rules live in `inbox/autoCloseRules.ts`.
 */

/** Field record of `inboxAutoClosePolicies`, shared with the save mutation. */
export const inboxAutoClosePolicyFields = {
	isEnabled: v.boolean(),
	// Whole days a waiting thread stays quiet before it is resolved.
	quietDays: v.number(),
	// When the policy was last switched on. No thread closes on silence that
	// started before this, so turning it on never resolves a backlog at once.
	enabledAt: v.optional(v.number()),
	updatedAt: v.number(),
};

/**
 * The auto-close columns a thread carries (`conversationThreads`). All
 * optional: absent means "never waited", "not opted out", "not closed
 * automatically". Only `inbox/threads/module.ts`, `inbox/autoClose.ts` and
 * `inbox/snooze.ts` write them.
 */
export const conversationThreadAutoCloseFields = {
	// When the thread last entered `waiting`; cleared when it leaves it.
	waitingSince: v.optional(v.number()),
	// A person turned auto-close off for this thread.
	isAutoCloseDisabled: v.optional(v.boolean()),
	// When a person restarted the quiet period: turned auto-close back on for
	// the thread, or woke its snooze by hand.
	autoCloseRestartedAt: v.optional(v.number()),
	// Set when the sweep resolved the thread; cleared by the next status change
	// or inbound reopen. Drives the "closed automatically" notice.
	autoClosedAt: v.optional(v.number()),
	// The rule's quiet days at that close, cleared with `autoClosedAt`. The
	// notice quotes these, not the current rule, which an admin may have
	// changed since.
	autoClosedQuietDays: v.optional(v.number()),
};
