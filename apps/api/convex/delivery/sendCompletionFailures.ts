import { type Infer, v } from 'convex/values';
import type { WorkId } from '@convex-dev/workpool';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logError, logWarn } from '../lib/runtimeLog';
import type { countableSendRefValidator } from '../lib/validators/send';
import type { workpoolRunResultValidator } from '../schema/sendCompletionFailures';
import { isSendWorkerOutcome } from './workerOutcome';

// ============================================================================
// Send completion failures (module) — #1195.
//
// `delivery/sendCompletion.ts:completeSend` catches a completion that throws and
// calls `recordCompletionFailure` below. From then on this module owns the
// record:
//   - the replay cron re-runs the stored completion with a capped backoff, so a
//     deployed fix drains the backlog on its own;
//   - a provider webhook for a Send with an open record replays it first
//     (`replayRecordedCompletion`), so the event lands on the state the
//     provider already reported instead of being refused against `queued`;
//   - operators read `status` and replay or re-open rows through
//     `npx convex run` (apps/docs "Platform operations").
//
// NOTHING HERE CAN DOUBLE-COUNT. A replay re-runs the same completion, and every
// arm of it either goes through the Send lifecycle (which reports a repeat as a
// duplicate or refuses it, never applies it twice) or checks that the Send is
// still `queued` first. A record whose Send has already left `queued` (a
// webhook, the stuck-send sweep, an operator) is resolved as `superseded`
// without replaying anything.
// ============================================================================

type CountableSendRef = Infer<typeof countableSendRefValidator>;
type RunResult = Infer<typeof workpoolRunResultValidator>;
type FailureRow = Doc<'sendCompletionFailures'>;

/** The arguments the workpool hands `completeSend`. */
export interface CompletionArgs {
	workId: WorkId;
	result: RunResult;
	context: { sendRef: CountableSendRef };
}

/** Cron replays per record before it waits for an operator. */
export const REPLAY_MAX_ATTEMPTS = 10;
const REPLAY_BASE_DELAY_MS = 10 * 60 * 1000;
const REPLAY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const REPLAY_BATCH_SIZE = 25;
const RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_BATCH_SIZE = 200;
const ERROR_TEXT_MAX_LENGTH = 2000;
const STATUS_COUNT_LIMIT = 1000;
const STATUS_SAMPLE_SIZE = 20;

/** 10 min, 20, 40 … capped at 6 h: about a day and a half over the whole cap. */
function replayDelayMs(attempts: number): number {
	return Math.min(REPLAY_BASE_DELAY_MS * 2 ** attempts, REPLAY_MAX_DELAY_MS);
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > ERROR_TEXT_MAX_LENGTH ? `${text.slice(0, ERROR_TEXT_MAX_LENGTH)}…` : text;
}

/** The readable part of a run result, kept after the payload is dropped. */
function summarize(result: RunResult): {
	outcomeKind: string;
	providerMessageId?: string;
	providerType?: string;
} {
	if (result.kind !== 'success') return { outcomeKind: result.kind };
	const outcome: unknown = result.returnValue;
	if (!isSendWorkerOutcome(outcome)) return { outcomeKind: 'unreadable' };
	switch (outcome.kind) {
		case 'accepted':
			return {
				outcomeKind: outcome.kind,
				providerMessageId: outcome.providerMessageId,
				providerType: outcome.providerType,
			};
		case 'acceptanceUnknown':
			return { outcomeKind: outcome.kind, providerMessageId: outcome.providerMessageId };
		default:
			return { outcomeKind: outcome.kind };
	}
}

/**
 * Record a completion that threw, in the caller's (committing) transaction.
 *
 * FIRST THE PROVIDER IDENTITY. An `accepted` outcome's message id is stamped on
 * the Send while it is still `queued` and has none, so provider feedback for it
 * resolves to this row from now on. An id the row already holds is never
 * replaced: a different one is exactly the MTA identity conflict the custody
 * arm refuses, and the record keeps both for an operator to read.
 *
 * Then the record, one per work id: a second `onComplete` for the same work
 * updates the row it already has.
 */
export async function recordCompletionFailure(
	ctx: MutationCtx,
	args: CompletionArgs,
	error: unknown
): Promise<void> {
	const now = Date.now();
	const { sendRef } = args.context;
	const summary = summarize(args.result);
	const lastError = errorText(error);

	if (summary.outcomeKind === 'accepted' && summary.providerMessageId) {
		const send = await ctx.db.get(sendRef.id);
		if (send && send.status === 'queued' && !send.providerMessageId) {
			await ctx.db.patch(sendRef.id, {
				providerMessageId: summary.providerMessageId,
				providerType: summary.providerType,
			});
		}
	}

	const existing = await ctx.db
		.query('sendCompletionFailures')
		.withIndex('by_work_id', (q) => q.eq('workId', args.workId))
		.first();
	let failureId: Id<'sendCompletionFailures'>;
	if (existing && existing.sendRef.id === sendRef.id) {
		failureId = existing._id;
		await ctx.db.patch(existing._id, {
			...summary,
			result: args.result,
			status: 'open',
			resolution: undefined,
			resolvedAt: undefined,
			lastError,
			lastFailedAt: now,
			nextReplayAt: now + replayDelayMs(existing.replayAttempts),
		});
	} else {
		failureId = await ctx.db.insert('sendCompletionFailures', {
			...summary,
			sendRef,
			workId: args.workId,
			result: args.result,
			status: 'open',
			lastError,
			replayAttempts: 0,
			firstFailedAt: now,
			lastFailedAt: now,
			nextReplayAt: now + replayDelayMs(0),
		});
	}
	// The error text stays in the row: a validator error quotes the document it
	// refused, and that can carry a recipient address.
	logError('[SendCompletion] Completion failed; outcome recorded for replay', {
		failureId,
		workId: args.workId,
		sendKind: sendRef.kind,
		sendId: sendRef.id,
		outcomeKind: summary.outcomeKind,
	});
}

async function resolveRow(
	ctx: MutationCtx,
	row: FailureRow,
	resolution: 'replayed' | 'superseded',
	now: number
): Promise<void> {
	await ctx.db.patch(row._id, {
		status: 'resolved',
		resolution,
		resolvedAt: now,
		result: undefined,
		nextReplayAt: undefined,
	});
}

async function unresolvedRowsForSend(
	ctx: MutationCtx,
	sendId: CountableSendRef['id']
): Promise<FailureRow[]> {
	const rows = await ctx.db
		.query('sendCompletionFailures')
		.withIndex('by_send', (q) => q.eq('sendRef.id', sendId))
		.take(10);
	return rows.filter((row) => row.status !== 'resolved');
}

/**
 * Before a provider event is applied to a `queued` Send, replay any completion
 * recorded for it. A bounce that arrives while the record waits would otherwise
 * be refused (`queued → bounced` is not an edge) and lost. Never throws: a
 * replay that fails again leaves the record as it was and the event goes on to
 * the lifecycle, which decides as before.
 */
export async function replayRecordedCompletion(
	ctx: MutationCtx,
	sendRef: CountableSendRef
): Promise<void> {
	const send = await ctx.db.get(sendRef.id);
	if (send?.status !== 'queued') return;
	for (const row of await unresolvedRowsForSend(ctx, sendRef.id)) {
		try {
			await ctx.runMutation(internal.delivery.sendCompletionFailures.replayCompletionFailure, {
				failureId: row._id,
				trigger: 'webhook',
			});
		} catch {
			logError('[SendCompletion] Replay before provider event failed', { failureId: row._id });
		}
	}
}

/** The stuck-send sweep closed this Send itself; its records have nothing left to replay. */
export async function supersedeCompletionFailures(
	ctx: MutationCtx,
	sendId: CountableSendRef['id'],
	now: number
): Promise<void> {
	for (const row of await unresolvedRowsForSend(ctx, sendId)) {
		await resolveRow(ctx, row, 'superseded', now);
	}
}

const replayTriggerValidator = v.union(
	v.literal('cron'),
	v.literal('webhook'),
	v.literal('operator')
);

/**
 * Re-run one recorded completion. `trigger` defaults to `operator`, which is
 * what `npx convex run delivery/sendCompletionFailures:replayCompletionFailure
 * '{"failureId": "…"}'` means; an operator may replay an `exhausted` row. Only
 * cron replays spend the attempt cap.
 */
export const replayCompletionFailure = internalMutation({
	args: {
		failureId: v.id('sendCompletionFailures'),
		trigger: v.optional(replayTriggerValidator),
	},
	returns: v.union(
		v.literal('replayed'),
		v.literal('superseded'),
		v.literal('failed'),
		v.literal('skipped')
	),
	handler: async (ctx, { failureId, trigger = 'operator' }) => {
		const row = await ctx.db.get(failureId);
		if (!row || row.status === 'resolved') return 'skipped';
		const now = Date.now();
		// A cron replay that lost a race with another one (or an exhausted row)
		// leaves the record alone, so one failure never spends two attempts.
		if (trigger === 'cron' && (row.status !== 'open' || (row.nextReplayAt ?? 0) > now)) {
			return 'skipped';
		}

		const send = await ctx.db.get(row.sendRef.id);
		if (!send || send.status !== 'queued') {
			await resolveRow(ctx, row, 'superseded', now);
			return 'superseded';
		}
		if (!row.result) {
			await ctx.db.patch(row._id, {
				status: 'exhausted',
				nextReplayAt: undefined,
				lastError: 'No stored result to replay',
			});
			return 'failed';
		}

		try {
			await ctx.runMutation(internal.delivery.sendCompletion.applyCompletion, {
				workId: row.workId as WorkId,
				result: row.result,
				context: { sendRef: row.sendRef },
			});
		} catch (error) {
			const replayAttempts = trigger === 'cron' ? row.replayAttempts + 1 : row.replayAttempts;
			const schedule =
				trigger !== 'cron'
					? {}
					: replayAttempts >= REPLAY_MAX_ATTEMPTS
						? { status: 'exhausted' as const, nextReplayAt: undefined }
						: { nextReplayAt: now + replayDelayMs(replayAttempts) };
			await ctx.db.patch(row._id, {
				...schedule,
				replayAttempts,
				lastError: errorText(error),
				lastFailedAt: now,
			});
			logWarn('[SendCompletion] Replay failed', { failureId, trigger, replayAttempts });
			return 'failed';
		}
		await resolveRow(ctx, row, 'replayed', now);
		return 'replayed';
	},
});

/** Cron: schedule every open record whose backoff has run out, each in its own transaction. */
export const replayDueCompletionFailures = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const due = await ctx.db
			.query('sendCompletionFailures')
			.withIndex('by_status_and_next_replay', (q) =>
				q.eq('status', 'open').lte('nextReplayAt', now)
			)
			.take(REPLAY_BATCH_SIZE);
		for (const row of due) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.sendCompletionFailures.replayCompletionFailure,
				{ failureId: row._id, trigger: 'cron' }
			);
		}
		return { scheduled: due.length };
	},
});

/** Cron: delete records resolved more than 30 days ago. */
export const purgeResolvedCompletionFailures = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - RESOLVED_RETENTION_MS;
		const rows = await ctx.db
			.query('sendCompletionFailures')
			.withIndex('by_status_and_resolved_at', (q) =>
				q.eq('status', 'resolved').lt('resolvedAt', cutoff)
			)
			.take(PURGE_BATCH_SIZE);
		for (const row of rows) await ctx.db.delete(row._id);
		return { deleted: rows.length };
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
 * `npx convex run delivery/sendCompletionFailures:status`. Counts stop at 1000.
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
				replayAttempts: row.replayAttempts,
				firstFailedAt: row.firstFailedAt,
				nextReplayAt: row.nextReplayAt ?? null,
				lastError: row.lastError,
			})),
		};
	},
});
