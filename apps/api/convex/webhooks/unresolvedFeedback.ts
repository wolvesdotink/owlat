import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalQuery, type DatabaseReader, type MutationCtx } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import { normalizeEmail } from '../lib/inputGuards';
import { bounceTypeValidator } from '../lib/literalValidators';
import { logError } from '../lib/runtimeLog';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { internalMutation } from '../lib/writeFence';
import type { TransitionOutcome } from '../delivery/sendLifecycle';

// ============================================================================
// Unresolved feedback (#1194).
//
// A bounce or complaint whose provider message id matched no Send used to be
// logged and dropped. `./unresolvedBounce.ts` now stores it here instead, and
// this module owns the rows from then on:
//   - the replay cron retries each row a few times over the first day, which
//     covers a webhook that raced the completion storing the id;
//   - an operator replays every open row after a repair writes ids back
//     (`replayOpen`), or one row by id (`replay`), through `npx convex run`;
//   - the Delivery page shows the 30-day count (`getSummary`), and `status`
//     gives an operator the full picture;
//   - rows are deleted 90 days after they were first seen, the same horizon
//     as the raw `webhookPayloads` they came from.
//
// A REPLAY IS THE ORDINARY TRANSITION. It calls the same resolver the webhook
// called, so whatever that resolver does first (a recorded send completion
// replayed before the event, for one) happens here too, and the Send lifecycle
// reports a repeat as a duplicate rather than applying it twice. A row leaves
// `open` the moment its id resolves, so a second replay of it is a no-op.
// ============================================================================

type FeedbackRow = Doc<'unresolvedFeedback'>;
type ReplayResult = 'replayed' | 'refused' | 'unmatched' | 'failed' | 'skipped';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Automatic replays after the row is first stored: 10 min, 1 h, 6 h, 24 h. */
const REPLAY_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, DAY_MS] as const;
export const AUTOMATIC_REPLAY_ATTEMPTS = REPLAY_DELAYS_MS.length;
export const RETENTION_MS = 90 * DAY_MS;
/** The window the Delivery page counts. */
export const SUMMARY_WINDOW_MS = 30 * DAY_MS;
const COUNT_LIMIT = 1000;
const REPLAY_BATCH_SIZE = 100;
const PURGE_BATCH_SIZE = 200;
const SAMPLE_SIZE = 20;
const BOUNCE_MESSAGE_MAX_LENGTH = 1000;
const RECIPIENT_MAX_LENGTH = 320;

function clamp(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The delay before automatic replay `attempt` (0-based), or none once they are spent. */
function nextReplayAt(now: number, attempt: number): number | undefined {
	const delay = REPLAY_DELAYS_MS[attempt];
	return delay === undefined ? undefined : now + delay;
}

/**
 * Store one unresolved signal. A provider redelivering the same event bumps
 * the row it already has, so a retried webhook never adds a second row and
 * the table holds at most one row per message id and kind.
 */
export const record = internalMutation({
	args: {
		kind: v.union(v.literal('bounce'), v.literal('complaint')),
		providerMessageId: v.string(),
		providerType: v.optional(v.string()),
		recipient: v.optional(v.string()),
		bounceType: v.optional(bounceTypeValidator),
		bounceMessage: v.optional(v.string()),
		deliveryDomain: v.optional(v.string()),
		at: v.number(),
		isSuppressed: v.boolean(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const recipient = args.recipient
			? clamp(normalizeEmail(args.recipient), RECIPIENT_MAX_LENGTH)
			: undefined;
		const existing = await ctx.db
			.query('unresolvedFeedback')
			.withIndex('by_message_id_and_kind', (q) =>
				q.eq('providerMessageId', args.providerMessageId).eq('kind', args.kind)
			)
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, {
				occurrences: existing.occurrences + 1,
				lastSeenAt: now,
				isSuppressed: existing.isSuppressed || args.isSuppressed,
				...(recipient && !existing.recipient ? { recipient } : {}),
			});
			return existing._id;
		}
		return await ctx.db.insert('unresolvedFeedback', {
			kind: args.kind,
			providerMessageId: args.providerMessageId,
			...(args.providerType ? { providerType: args.providerType } : {}),
			...(recipient ? { recipient } : {}),
			...(args.bounceType ? { bounceType: args.bounceType } : {}),
			...(args.bounceMessage
				? { bounceMessage: clamp(args.bounceMessage, BOUNCE_MESSAGE_MAX_LENGTH) }
				: {}),
			...(args.deliveryDomain ? { deliveryDomain: args.deliveryDomain } : {}),
			at: args.at,
			isSuppressed: args.isSuppressed,
			occurrences: 1,
			firstSeenAt: now,
			lastSeenAt: now,
			status: 'open',
			replayAttempts: 0,
			nextReplayAt: nextReplayAt(now, 0),
		});
	},
});

/** Run the row's event through the resolver the webhook used. */
async function transitionFor(ctx: MutationCtx, row: FeedbackRow): Promise<TransitionOutcome> {
	const resolver =
		row.providerType === OWN_ARM_TRANSPORT_KIND
			? internal.delivery.sendLifecycle.transitionMtaByProviderMessageId
			: internal.delivery.sendLifecycle.transitionByProviderMessageId;
	const transition =
		row.kind === 'bounce'
			? {
					to: 'bounced' as const,
					at: row.at,
					bounceType: row.bounceType ?? ('soft' as const),
					...(row.bounceMessage ? { bounceMessage: row.bounceMessage } : {}),
				}
			: { to: 'complained' as const, at: row.at };
	return (await ctx.runMutation(resolver, {
		providerMessageId: row.providerMessageId,
		transition,
	})) as TransitionOutcome;
}

/**
 * Replay one stored row. `trigger` defaults to `operator`, which is what
 * `npx convex run webhooks/unresolvedFeedback:replay '{"feedbackId": "…"}'`
 * means: it replays any open row and does not spend an automatic attempt. A
 * `cron` replay only runs a row whose next attempt is due.
 */
export const replay = internalMutation({
	args: {
		feedbackId: v.id('unresolvedFeedback'),
		trigger: v.optional(v.union(v.literal('cron'), v.literal('operator'))),
	},
	handler: async (ctx, { feedbackId, trigger = 'operator' }): Promise<ReplayResult> => {
		const row = await ctx.db.get(feedbackId);
		if (!row || row.status !== 'open') return 'skipped';
		const now = Date.now();
		if (trigger === 'cron' && (row.nextReplayAt === undefined || row.nextReplayAt > now)) {
			return 'skipped';
		}

		let outcome: TransitionOutcome | null = null;
		try {
			outcome = await transitionFor(ctx, row);
		} catch (error) {
			// The nested transition rolled its own writes back. Spend the attempt
			// below, so a transition that keeps throwing is not retried every tick.
			logError('[Unresolved Feedback] Replay threw', {
				feedbackId,
				errorName: error instanceof Error ? error.name : typeof error,
			});
		}

		if (outcome && (outcome.ok || outcome.reason !== 'send_not_found')) {
			await ctx.db.patch(row._id, {
				status: 'resolved',
				resolution: outcome.ok ? 'replayed' : 'refused',
				resolvedAt: now,
				nextReplayAt: undefined,
				bounceMessage: undefined,
			});
			return outcome.ok ? 'replayed' : 'refused';
		}
		if (trigger === 'cron') {
			const replayAttempts = row.replayAttempts + 1;
			await ctx.db.patch(row._id, {
				replayAttempts,
				nextReplayAt: nextReplayAt(now, replayAttempts),
			});
		}
		return outcome ? 'unmatched' : 'failed';
	},
});

/** Cron: schedule every open row whose next automatic replay is due. */
export const replayDue = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		// The lower bound keeps rows with no next attempt (absent sorts first) out.
		const due = await ctx.db
			.query('unresolvedFeedback')
			.withIndex('by_status_and_next_replay', (q) =>
				q.eq('status', 'open').gte('nextReplayAt', 0).lte('nextReplayAt', now)
			)
			.take(REPLAY_BATCH_SIZE);
		for (const row of due) {
			await ctx.scheduler.runAfter(0, internal.webhooks.unresolvedFeedback.replay, {
				feedbackId: row._id,
				trigger: 'cron',
			});
		}
		return { scheduled: due.length };
	},
});

/**
 * Operator: replay every open row, oldest first, after a repair wrote missing
 * provider ids back. Schedules one replay per row and walks itself page by
 * page, so one call covers the whole table:
 * `npx convex run webhooks/unresolvedFeedback:replayOpen`.
 */
export const replayOpen = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query('unresolvedFeedback')
			.withIndex('by_status_and_first_seen', (q) => q.eq('status', 'open'))
			.paginate({ numItems: REPLAY_BATCH_SIZE, cursor: args.cursor ?? null });
		for (const row of page.page) {
			await ctx.scheduler.runAfter(0, internal.webhooks.unresolvedFeedback.replay, {
				feedbackId: row._id,
				trigger: 'operator',
			});
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.webhooks.unresolvedFeedback.replayOpen, {
				cursor: page.continueCursor,
			});
		}
		return { scheduled: page.page.length, isDone: page.isDone };
	},
});

/** Cron: delete rows first seen more than 90 days ago, a batch at a time. */
export const purgeExpired = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - RETENTION_MS;
		const rows = await ctx.db
			.query('unresolvedFeedback')
			.withIndex('by_first_seen', (q) => q.lt('firstSeenAt', cutoff))
			.take(PURGE_BATCH_SIZE);
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length === PURGE_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.webhooks.unresolvedFeedback.purgeExpired, {});
		}
		return { deleted: rows.length };
	},
});

interface WindowCounts {
	total: number;
	bounces: number;
	complaints: number;
	suppressed: number;
	open: number;
	isCapped: boolean;
}

async function countSince(ctx: { db: DatabaseReader }, since: number): Promise<WindowCounts> {
	const rows = await ctx.db
		.query('unresolvedFeedback')
		.withIndex('by_first_seen', (q) => q.gte('firstSeenAt', since))
		.take(COUNT_LIMIT + 1);
	const counted = rows.slice(0, COUNT_LIMIT);
	return {
		total: counted.length,
		bounces: counted.filter((row) => row.kind === 'bounce').length,
		complaints: counted.filter((row) => row.kind === 'complaint').length,
		suppressed: counted.filter((row) => row.isSuppressed).length,
		open: counted.filter((row) => row.status === 'open').length,
		isCapped: rows.length > COUNT_LIMIT,
	};
}

/**
 * The Delivery page's line: how many bounces and complaints of the last 30
 * days matched no send, and how many of those still do. Counts only; no
 * address or message id leaves the backend. Capped at 1,000 rows, flagged.
 */
export const getSummary = adminQuery({
	args: {},
	handler: async (ctx) => await countSince(ctx, Date.now() - SUMMARY_WINDOW_MS),
});

/**
 * Operator: the 30-day counts, the open backlog's age and a sample of open
 * rows, without addresses: `npx convex run webhooks/unresolvedFeedback:status`.
 */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const open = await ctx.db
			.query('unresolvedFeedback')
			.withIndex('by_status_and_first_seen', (q) => q.eq('status', 'open'))
			.take(COUNT_LIMIT + 1);
		return {
			last30Days: await countSince(ctx, now - SUMMARY_WINDOW_MS),
			openCount: Math.min(open.length, COUNT_LIMIT),
			isOpenCountCapped: open.length > COUNT_LIMIT,
			oldestOpenFirstSeenAt: open[0]?.firstSeenAt ?? null,
			sample: open.slice(0, SAMPLE_SIZE).map((row) => ({
				feedbackId: row._id,
				kind: row.kind,
				providerMessageId: row.providerMessageId,
				providerType: row.providerType ?? null,
				isSuppressed: row.isSuppressed,
				occurrences: row.occurrences,
				replayAttempts: row.replayAttempts,
				firstSeenAt: row.firstSeenAt,
			})),
		};
	},
});
