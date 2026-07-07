/**
 * Team-inbox thread snooze — hide a conversation from the Open filter until a
 * chosen time, then float it back with a "returned" marker.
 *
 * Mirrors the Postbox mail snooze architecture (mail/snooze.ts): store
 * `snoozedUntil` on the row, filter still-snoozed rows out of the Open list
 * (inbox/queries.ts → listThreads), and let a 1-minute wake cron
 * (`internalSweep`) clear the flag once the time passes. The mail module's
 * >100-messages cron pitfall — a bare `lte('snoozedUntil', now)` on a
 * single-field index pages the never-snoozed (`undefined`) rows first and wakes
 * nothing — is fixed here the same way: lower-bound the range with `gt(0)`.
 *
 * A resurfaced thread is stamped with `snoozeReturnedAt` (not a status change)
 * so the row shows a transient "Returned" marker. An inbound reply on a snoozed
 * thread clears the snooze early via the Conversation thread module's
 * `inbound_activity` reducer (inbox/threads/module.ts).
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { getMutationContext } from '../lib/sessionOrganization';

/**
 * Snooze a thread until a future timestamp. Admin-only (shared inbox), audited.
 */
export const snoozeThread = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		until: v.number(),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		await getOrThrow(ctx, args.threadId, 'Thread');
		if (args.until <= Date.now()) {
			throwInvalidInput('Snooze time must be in the future');
		}
		await ctx.db.patch(args.threadId, {
			snoozedUntil: args.until,
			// Clear any stale "returned" marker from a prior snooze cycle.
			snoozeReturnedAt: undefined,
		});
		await recordAuditLog(ctx, {
			userId,
			action: 'thread.snoozed',
			resource: 'conversation_thread',
			resourceId: args.threadId,
			details: { until: args.until },
		});
		return { success: true };
	},
});

/**
 * Wake a snoozed thread now (manual un-snooze). Clears the flag without a
 * "returned" marker — the operator is looking right at it.
 */
export const unsnoozeThread = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		if (thread.snoozedUntil === undefined) {
			return { success: true };
		}
		await ctx.db.patch(args.threadId, {
			snoozedUntil: undefined,
			snoozeReturnedAt: undefined,
		});
		await recordAuditLog(ctx, {
			userId,
			action: 'thread.unsnoozed',
			resource: 'conversation_thread',
			resourceId: args.threadId,
			details: {},
		});
		return { success: true };
	},
});

// ── Internal cron sweep ────────────────────────────────────────────

/** Cron entry: pull due-snoozed threads and float them back with a marker. */
export const internalSweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		// `snoozedUntil` is optional; on a single-field index Convex sorts rows
		// whose value is `undefined` BEFORE every number, so a bare
		// `lte('snoozedUntil', now)` would fill the page with never-snoozed rows and
		// wake nothing. Lower-bound with `gt(0)` to exclude them (snoozeThread
		// rejects any `until <= now`, so a real value is never <= 0).
		const dueRows = await ctx.db
			.query('conversationThreads')
			.withIndex('by_snoozed_until', (q) => q.gt('snoozedUntil', 0).lte('snoozedUntil', now))
			.take(100);
		// No post-filter needed: the `gt(0)` lower bound above already excludes
		// every never-snoozed (`undefined`) row, so every returned row is due.
		for (const t of dueRows) {
			await ctx.db.patch(t._id, {
				snoozedUntil: undefined,
				snoozeReturnedAt: now,
			});
		}
		return { woken: dueRows.length };
	},
});
