/**
 * Team Inbox response targets — the reads behind the list highlights and the
 * analytics page, plus the one write the analytics page makes (starting the
 * history back-fill). Owner/admin behind the `inbox` flag, like the Team Inbox.
 */

import { v } from 'convex/values';
import type { QueryCtx } from '../../_generated/server';
import { readMigrationRun } from '../../lib/migrationLedger';
import { throwInvalidInput } from '../../_utils/errors';
import { FILTER_COUNT_CAP, threadAssigneeValidator } from '../threadFilters';
import { buildSlaThreadQuery, slaSliceNow } from './slices';
import { readSlaPolicyRow, teamInboxAdminMutation, teamInboxAdminQuery } from './policy';
import { slaPolicyView } from './policyRules';
import { summarizeResponseAnalytics } from './analyticsRules';
import {
	MIGRATION as HISTORY_MIGRATION,
	beginResponseHistoryBackfill,
} from '../../migrations/0065_backfill_thread_response_metrics';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The widest range the analytics page asks for. */
const MAX_ANALYTICS_DAYS = 366;
/**
 * Conversations one analytics read loads. A range with more reads its newest
 * conversations and says from when its numbers are complete.
 */
const MAX_ANALYTICS_THREADS = 3000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether targets are on, and how many threads are overdue / due within the
 * hour, for the Team Inbox highlights. Counts read at most `cap` rows, like
 * the tab counts; `assignee` narrows them the same way. `now` is the list's
 * clock (see `slaSliceNow`): a new value re-counts as deadlines pass.
 */
export const getListSummary = teamInboxAdminQuery({
	args: { assignee: v.optional(threadAssigneeValidator), now: v.optional(v.number()) },
	handler: async (ctx, args, session) => {
		const isEnabled = slaPolicyView(await readSlaPolicyRow(ctx)) !== null;
		if (!isEnabled) return { isEnabled, overdue: 0, dueSoon: 0, cap: FILTER_COUNT_CAP };
		const now = slaSliceNow(args.now);
		const count = async (slice: 'sla-overdue' | 'sla-due-soon') =>
			(
				await buildSlaThreadQuery(ctx, slice, session.userId, now, args.assignee).take(
					FILTER_COUNT_CAP
				)
			).length;
		const [overdue, dueSoon] = await Promise.all([count('sla-overdue'), count('sla-due-soon')]);
		return { isEnabled, overdue, dueSoon, cap: FILTER_COUNT_CAP };
	},
});

function dayStart(day: string): number {
	const ms = DAY_PATTERN.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
	if (!Number.isFinite(ms)) throwInvalidInput('Dates must be YYYY-MM-DD');
	return ms;
}

/** Display name or email per assignee, for the breakdown table. */
async function assigneeNames(ctx: QueryCtx, userIds: readonly string[]) {
	const names: Record<string, string> = {};
	for (const userId of userIds) {
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', userId))
			.first();
		if (profile) names[userId] = profile.name || profile.email;
	}
	return names;
}

/**
 * Response analytics for the conversations that started between `fromDay`
 * and `toDay` (UTC dates, inclusive). See ./analyticsRules.ts for what each
 * number means.
 */
export const getAnalytics = teamInboxAdminQuery({
	args: { fromDay: v.string(), toDay: v.string() },
	handler: async (ctx, args) => {
		const fromMs = dayStart(args.fromDay);
		const toMs = dayStart(args.toDay) + DAY_MS;
		if (toMs <= fromMs) throwInvalidInput('The range must end after it starts');
		if (toMs - fromMs > MAX_ANALYTICS_DAYS * DAY_MS) {
			throwInvalidInput(`The range can span at most ${MAX_ANALYTICS_DAYS} days`);
		}

		const threads = await ctx.db
			.query('conversationThreads')
			.withIndex('by_first_message_at', (q) =>
				q.gte('firstMessageAt', fromMs).lt('firstMessageAt', toMs)
			)
			.order('desc')
			.take(MAX_ANALYTICS_THREADS);
		const isTruncated = threads.length === MAX_ANALYTICS_THREADS;
		// Truncated: only days from the oldest conversation read are complete.
		const completeFromMs = isTruncated ? Math.min(...threads.map((t) => t.firstMessageAt)) : fromMs;

		const summary = summarizeResponseAnalytics(threads, { fromMs, toMs, now: Date.now() });
		const userIds = summary.assignees.flatMap((row) => (row.userId ? [row.userId] : []));
		const history = await readMigrationRun(ctx, HISTORY_MIGRATION);
		const policy = await readSlaPolicyRow(ctx);
		return {
			...summary,
			assigneeNames: await assigneeNames(ctx, userIds),
			isTruncated,
			completeFromMs,
			isTargetsEnabled: slaPolicyView(policy) !== null,
			history: history ? history.status : ('not_started' as const),
		};
	},
});

/**
 * Start the history back-fill (migration 0065) if it never ran. The analytics
 * page calls this when it finds no history; a run in progress or finished is
 * left alone.
 */
export const startHistoryBackfill = teamInboxAdminMutation({
	args: {},
	handler: async (ctx) => {
		if (await readMigrationRun(ctx, HISTORY_MIGRATION)) return { started: false };
		return { started: (await beginResponseHistoryBackfill(ctx)) !== null };
	},
});
