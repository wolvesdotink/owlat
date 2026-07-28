/**
 * The seed-mailbox ROTATION sweep — the cron that puts the hygiene nudge in
 * front of a human.
 *
 * Rotation due-ness is a pure timestamp decision: it needs no IMAP session, no
 * credential and no worker, only the account's `createdAt` and the operator's
 * last acknowledgement. It lived on the mail-sync probe sweep once, and that
 * coupling was the defect — the nudge could only be offered to a seed that
 * happened to have an outstanding, settled, unexpired probe at that instant, so
 * a 90-day-old seed on a deployment between campaigns (every probe already
 * classified) and a seed sitting in `auth_error` — the one most in need of
 * rotating — never produced the artifact at all. Here it is decided by the
 * clock and nothing else, and every seed is reached whatever its status.
 *
 * D16: paged with a CURSOR, bounded per tick, self-rescheduling to the next
 * page. A bare bounded page with no cursor starves whichever orgs sort last.
 *
 * D2: with no seed mailboxes connected the page is empty and the sweep is a
 * no-op forever. The reminder itself is advisory — it never blocks a send, a
 * phase promotion or a screen.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { toPaginationCursor } from '../lib/paginationCursor';
import { emitSeedRotationReminderFor } from './seedAccounts';

/**
 * Seed accounts examined per tick. Every deployment's whole seed set is a
 * handful per org, so one page is normally the entire sweep; the cursor exists
 * for the multi-org case.
 */
const SEED_ROTATION_PAGE_SIZE = 50;

/**
 * Offer the rotation nudge to one page of seed accounts.
 *
 * Deliberately NOT filtered by status: `CONNECTABLE_ACCOUNT_STATUSES` is the
 * right filter for "can the worker open this mailbox", and exactly the wrong
 * one for "should the operator be told to replace this seed".
 *
 * The emission is idempotent per un-acknowledged cycle
 * ({@link emitSeedRotationReminderFor} holds that invariant), so re-running a
 * page — a retried tick, an overlapping schedule — cannot multiply the audit
 * rows an operator sees.
 */
export const sweepSeedRotationReminders = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const page = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_purpose', (q) => q.eq('purpose', 'seed'))
			.paginate({
				cursor: toPaginationCursor(args.cursor),
				numItems: SEED_ROTATION_PAGE_SIZE,
			});

		let reminded = 0;
		for (const account of page.page) {
			if (await emitSeedRotationReminderFor(ctx, account, now)) reminded += 1;
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.analytics.seedRotationSweep.sweepSeedRotationReminders,
				{
					cursor: page.continueCursor,
				}
			);
		}

		return { reminded, examined: page.page.length, done: page.isDone };
	},
});
