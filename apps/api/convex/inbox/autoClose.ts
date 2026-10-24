/**
 * Team Inbox auto-close: resolve a thread that has waited on the customer for
 * N quiet days.
 *
 * Off by default; an owner or admin switches it on for the Team Inbox with the
 * number of days (one row per workspace, `inboxAutoClosePolicies`; absent =
 * off). Any thread can opt out, and a thread closed this way says so and can
 * be reopened like any other. The rules (when the quiet period started, when
 * it ends) are in `./autoCloseRules.ts`; the close itself is the thread
 * module's `auto_close` transition, so it moves the response clock, the open
 * counter, held questions and the audit trail like a manual resolve.
 *
 * The hourly sweep walks every waiting thread whose last customer message is
 * older than the quiet period, one page per mutation, chained, and closes each
 * due thread in a mutation of its own that checks again before it writes, so a
 * policy change, a reply or an opt-out in between wins. Rows it skips (opted
 * out, snoozed, a later reply) do not hold up the rest: the walk pages past
 * them.
 */

import { v } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import { teamInboxAdminMutation, teamInboxAdminQuery } from './sla/policy';
import { transition as threadTransition } from './threads/module';
import {
	autoCloseCutoff,
	autoCloseDaysProblem,
	autoCloseDueAt,
	autoClosePolicyView,
	isAutoCloseDue,
	quietSince,
	type AutoClosePolicyView,
} from './autoCloseRules';

const PAGE_SIZE = 100;

async function readPolicyRow(ctx: {
	db: QueryCtx['db'];
}): Promise<Doc<'inboxAutoClosePolicies'> | null> {
	return ctx.db.query('inboxAutoClosePolicies').first();
}

async function loadPolicy(ctx: { db: QueryCtx['db'] }): Promise<AutoClosePolicyView | null> {
	return autoClosePolicyView(await readPolicyRow(ctx));
}

/** The saved rule for the settings page; `null` = never saved (off). */
export const getPolicy = teamInboxAdminQuery({
	args: {},
	handler: async (ctx) => {
		const row = await readPolicyRow(ctx);
		if (!row) return null;
		return { isEnabled: row.isEnabled, quietDays: row.quietDays, updatedAt: row.updatedAt };
	},
});

/**
 * Save the rule. Switching it on (from off or never saved) stamps
 * `enabledAt`, so threads that have been quiet for longer get the full period
 * from now instead of closing on the next sweep. Changing the days of a rule
 * that is already on keeps the stamp.
 */
export const savePolicy = teamInboxAdminMutation({
	args: { isEnabled: v.boolean(), quietDays: v.number() },
	handler: async (ctx, args, session) => {
		const problem = autoCloseDaysProblem(args.quietDays);
		if (problem) throwInvalidInput(problem);
		const now = Date.now();
		const existing = await readPolicyRow(ctx);
		const turnedOn = args.isEnabled && !existing?.isEnabled;
		const enabledAt = turnedOn ? now : existing?.enabledAt;
		const row = { isEnabled: args.isEnabled, quietDays: args.quietDays, enabledAt, updatedAt: now };
		if (existing) await ctx.db.patch(existing._id, row);
		else await ctx.db.insert('inboxAutoClosePolicies', row);

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'settings.inbox_auto_close_updated',
			resource: 'settings',
			details: { isEnabled: args.isEnabled, quietDays: args.quietDays },
		});
		return { success: true as const };
	},
});

/**
 * One thread's auto-close state for the reader: whether the rule is on, the
 * thread opted out, when it will close if nobody writes, and whether its
 * current resolve was automatic.
 */
export const getThreadAutoClose = teamInboxAdminQuery({
	args: { threadId: v.id('conversationThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const policy = await loadPolicy(ctx);
		return {
			isPolicyEnabled: policy !== null,
			quietDays: policy?.quietDays ?? null,
			isDisabledForThread: thread.isAutoCloseDisabled === true,
			dueAt: autoCloseDueAt(thread, policy),
			autoClosedAt: thread.autoClosedAt ?? null,
		};
	},
});

/**
 * Turn auto-close off (or back on) for one thread. Turning it back on starts
 * the quiet period over, so a thread that sat opted out for weeks does not
 * close the moment it is let back in. A no-op (and no audit row) when the
 * thread is already in the asked state.
 */
export const setThreadAutoClose = teamInboxAdminMutation({
	args: { threadId: v.id('conversationThreads'), isDisabled: v.boolean() },
	handler: async (ctx, args, session) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		if ((thread.isAutoCloseDisabled === true) === args.isDisabled) return { changed: false };
		await ctx.db.patch(
			args.threadId,
			args.isDisabled
				? { isAutoCloseDisabled: true }
				: { isAutoCloseDisabled: undefined, autoCloseRestartedAt: Date.now() }
		);
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'thread.auto_close_changed',
			resource: 'conversation_thread',
			resourceId: args.threadId,
			details: { isDisabled: args.isDisabled },
		});
		return { changed: true };
	},
});

/**
 * Cron entry and its continuation: find the due threads on one page and hand
 * each to `closeQuietThread`. A close can carry real work (held questions
 * leave the Answer queue), so each runs in its own transaction instead of a
 * page of them sharing one. The first call fixes the index bound (`cutoff`,
 * from the policy at that moment); every later page keeps it, so the cursor
 * stays valid, and judges each thread by the policy it reads now.
 */
export const sweep = internalMutation({
	args: {
		cutoff: v.optional(v.number()),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args): Promise<{ due: number; isDone: boolean }> => {
		const policy = await loadPolicy(ctx);
		if (!policy) return { due: 0, isDone: true };
		const now = Date.now();
		const cutoff = args.cutoff ?? autoCloseCutoff(policy, now);

		const page = await ctx.db
			.query('conversationThreads')
			.withIndex('by_status_and_last_message_at', (q) =>
				q.eq('status', 'waiting').lte('lastMessageAt', cutoff)
			)
			.paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE });

		let due = 0;
		for (const thread of page.page) {
			if (!isAutoCloseDue(thread, policy, now)) continue;
			await ctx.scheduler.runAfter(0, internal.inbox.autoClose.closeQuietThread, {
				threadId: thread._id,
			});
			due++;
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.inbox.autoClose.sweep, {
				cutoff,
				cursor: page.continueCursor,
			});
		}
		return { due, isDone: page.isDone };
	},
});

/**
 * Resolve one thread the sweep found due, if it still is: the policy and the
 * thread are read again here, so a reply, an opt-out, a snooze or a policy
 * change since the sweep leaves it alone, and a repeated call does nothing.
 */
export const closeQuietThread = internalMutation({
	args: { threadId: v.id('conversationThreads') },
	handler: async (ctx, args): Promise<{ closed: boolean }> => {
		const policy = await loadPolicy(ctx);
		const thread = await ctx.db.get(args.threadId);
		const now = Date.now();
		if (!policy || !thread || !isAutoCloseDue(thread, policy, now)) return { closed: false };
		const outcome = await threadTransition(ctx, {
			threadId: thread._id,
			input: {
				kind: 'auto_close',
				at: now,
				quietDays: policy.quietDays,
				quietSince: quietSince(thread, policy),
			},
		});
		return { closed: outcome.ok && outcome.applied === 'transitioned' };
	},
});
