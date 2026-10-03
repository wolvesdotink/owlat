import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';

// ============================================================================
// Send completion failures — retention and the operator surface (#1195).
//
// The records themselves, their replay and parked provider events live in
// `./sendCompletionFailures`. This module deletes old records and gives an
// operator `npx convex run` access to the rest (apps/docs "Platform
// operations").
// ============================================================================

type FailureRow = Doc<'sendCompletionFailures'>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A resolved record holds no outcome any more; it is kept for the audit trail. */
export const RESOLVED_RETENTION_MS = 30 * DAY_MS;
/**
 * An exhausted record still holds the outcome an operator may want to replay,
 * so it is kept longer, but not forever: it can carry a deferral's envelope.
 */
export const EXHAUSTED_RETENTION_MS = 90 * DAY_MS;
export const PURGE_BATCH_SIZE = 200;
const STATUS_COUNT_LIMIT = 1000;
const STATUS_SAMPLE_SIZE = 20;

/**
 * Cron: delete resolved records 30 days and exhausted ones 90 days after their
 * last failure. One bounded batch per transaction; a full batch schedules the
 * next, so a backlog drains in one tick.
 */
export const purgeCompletionFailures = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const retention = [
			['resolved', RESOLVED_RETENTION_MS],
			['exhausted', EXHAUSTED_RETENTION_MS],
		] as const;
		let deleted = 0;
		for (const [status, retentionMs] of retention) {
			const rows = await ctx.db
				.query('sendCompletionFailures')
				.withIndex('by_status_and_last_failed_at', (q) =>
					q.eq('status', status).lt('lastFailedAt', now - retentionMs)
				)
				.take(PURGE_BATCH_SIZE - deleted);
			for (const row of rows) await ctx.db.delete(row._id);
			deleted += rows.length;
			if (deleted >= PURGE_BATCH_SIZE) break;
		}
		if (deleted >= PURGE_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.sendCompletionFailureAdmin.purgeCompletionFailures,
				{}
			);
		}
		return { deleted };
	},
});

/**
 * Operator: hand `exhausted` records back to the replay cron with a fresh
 * attempt budget, after the fault behind them is fixed. One record by id, or
 * up to 100 per call.
 */
export const reopenExhaustedCompletionFailures = internalMutation({
	args: { failureId: v.optional(v.id('sendCompletionFailures')) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const rows = args.failureId
			? [await ctx.db.get(args.failureId)].filter(
					(row): row is FailureRow => row?.status === 'exhausted'
				)
			: await ctx.db
					.query('sendCompletionFailures')
					.withIndex('by_status_and_next_replay', (q) => q.eq('status', 'exhausted'))
					.take(100);
		for (const row of rows) {
			await ctx.db.patch(row._id, { status: 'open', replayAttempts: 0, nextReplayAt: now });
		}
		return { reopened: rows.length };
	},
});

/**
 * Operator: how many completions are waiting, and the oldest of them.
 * `npx convex run delivery/sendCompletionFailureAdmin:status`. Counts stop at 1000.
 */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => {
		const unresolved = async (state: 'open' | 'exhausted') =>
			await ctx.db
				.query('sendCompletionFailures')
				.withIndex('by_status_and_next_replay', (q) => q.eq('status', state))
				.take(STATUS_COUNT_LIMIT);
		const open = await unresolved('open');
		const exhausted = await unresolved('exhausted');
		const pending = [...exhausted, ...open];
		return {
			open: open.length,
			exhausted: exhausted.length,
			oldestFailedAt: pending.reduce<number | null>(
				(oldest, row) =>
					oldest === null ? row.firstFailedAt : Math.min(oldest, row.firstFailedAt),
				null
			),
			sample: pending.slice(0, STATUS_SAMPLE_SIZE).map((row) => ({
				failureId: row._id,
				status: row.status,
				sendKind: row.sendRef.kind,
				sendId: row.sendRef.id,
				outcomeKind: row.outcomeKind,
				providerMessageId: row.providerMessageId ?? null,
				parkedEvents: row.pendingFeedback?.length ?? 0,
				replayAttempts: row.replayAttempts,
				firstFailedAt: row.firstFailedAt,
				nextReplayAt: row.nextReplayAt ?? null,
				lastError: row.lastError,
			})),
		};
	},
});
