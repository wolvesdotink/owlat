import { ConvexError, type Infer, v } from 'convex/values';
import type { WorkId } from '@convex-dev/workpool';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { isTransactionLimitError } from '../lib/convexLimitErrors';
import { logError, logWarn } from '../lib/runtimeLog';
import type { countableSendRefValidator } from '../lib/validators/send';
import type { workpoolRunResultValidator } from '../schema/sendCompletionFailures';
import {
	orderParkedFeedback,
	parkFeedbackOnRecordedCompletion,
	unresolvedCompletionFailures,
} from './sendCompletionFeedback';
import { isSendWorkerOutcome } from './workerOutcome';

// ============================================================================
// Send completion failures (module) — #1195.
//
// `delivery/sendCompletion.ts:completeSend` catches a completion that throws and
// calls `recordCompletionFailure` below. From then on this module owns the
// record:
//   - the replay cron re-runs the stored completion with a capped backoff, so a
//     deployed fix drains the backlog on its own;
//   - both provider-id entry points of the Send lifecycle go through
//     `applyProviderFeedback`: it replays an open record first, and when that
//     replay fails too, parks a terminal or delivery event on the record
//     (`./sendCompletionFeedback`) for the replay to apply after the completion;
//   - contact erasure deletes a contact's records in a phase of its own;
//   - operators read and re-open records in `./sendCompletionFailureAdmin`.
//
// NOTHING HERE CAN DOUBLE-COUNT. A replay re-runs the same completion, and every
// arm of it either goes through the Send lifecycle (which reports a repeat as a
// duplicate or refuses it, never applies it twice) or checks that the Send is
// still `queued` first. A record whose Send has already left `queued` only
// applies the events parked on it, then resolves as `superseded`.
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

/** 10 min, 20, 40 … capped at 6 h: about a day and a half over the whole cap. */
function replayDelayMs(attempts: number): number {
	return Math.min(REPLAY_BASE_DELAY_MS * 2 ** attempts, REPLAY_MAX_DELAY_MS);
}

/**
 * The diagnostic code stored for an error, never its text. A Convex validation
 * error quotes the whole document it refused, and the first line alone can
 * carry a name or a subject. An operator who needs the message runs
 * `applyRecordedCompletion` by hand: the CLI shows the error and nothing is
 * written.
 */
export function completionErrorCode(error: unknown): string {
	if (error instanceof ConvexError) {
		const data: unknown = error.data;
		const code =
			typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['code'] : null;
		return typeof code === 'string' && /^[a-z_]{1,40}$/i.test(code)
			? `CONVEX_ERROR_${code.toUpperCase()}`
			: 'CONVEX_ERROR';
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/does not match the schema|validator|ValidationError/i.test(message)) {
		return 'CONVEX_VALIDATION';
	}
	if (isTransactionLimitError(message)) return 'TRANSACTION_LIMIT';
	if (message.includes('conflicts with the Send provider identity')) {
		return 'MTA_IDENTITY_CONFLICT';
	}
	if (message.startsWith('Unhandled send worker outcome')) return 'UNHANDLED_WORKER_OUTCOME';
	if (error instanceof TypeError) return 'TYPE_ERROR';
	if (error instanceof RangeError) return 'RANGE_ERROR';
	return 'UNKNOWN';
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
 * updates the row it already has. A Send that is gone or soft-deleted (contact
 * erasure scrubs and soft-deletes it) gets no record: the stored outcome would
 * put the erased recipient back on disk.
 */
export async function recordCompletionFailure(
	ctx: MutationCtx,
	args: CompletionArgs,
	error: unknown
): Promise<void> {
	const now = Date.now();
	const { sendRef } = args.context;
	const summary = summarize(args.result);
	const lastError = completionErrorCode(error);
	const send = await ctx.db.get(sendRef.id);

	if (!send || send.deletedAt !== undefined) {
		logError('[SendCompletion] Completion failed for a deleted Send; nothing recorded', {
			workId: args.workId,
			sendKind: sendRef.kind,
			sendId: sendRef.id,
			outcomeKind: summary.outcomeKind,
		});
		return;
	}

	if (
		summary.outcomeKind === 'accepted' &&
		summary.providerMessageId &&
		send.status === 'queued' &&
		!send.providerMessageId
	) {
		await ctx.db.patch(sendRef.id, {
			providerMessageId: summary.providerMessageId,
			providerType: summary.providerType,
		});
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
			contactId: send.contactId,
			workId: args.workId,
			status: 'open',
			lastError,
			replayAttempts: 0,
			firstFailedAt: now,
			lastFailedAt: now,
			nextReplayAt: now + replayDelayMs(0),
		});
	}
	await storePayload(ctx, failureId, args.result);
	logError('[SendCompletion] Completion failed; outcome recorded for replay', {
		failureId,
		workId: args.workId,
		sendKind: sendRef.kind,
		sendId: sendRef.id,
		outcomeKind: summary.outcomeKind,
	});
}

/** The one payload row of a record, or null. Reads up to one 1 MiB document. */
async function payloadOf(
	ctx: MutationCtx,
	failureId: Id<'sendCompletionFailures'>
): Promise<Doc<'sendCompletionFailurePayloads'> | null> {
	return await ctx.db
		.query('sendCompletionFailurePayloads')
		.withIndex('by_failure', (q) => q.eq('failureId', failureId))
		.first();
}

async function storePayload(
	ctx: MutationCtx,
	failureId: Id<'sendCompletionFailures'>,
	result: RunResult
): Promise<void> {
	const existing = await payloadOf(ctx, failureId);
	if (existing) await ctx.db.patch(existing._id, { result });
	else await ctx.db.insert('sendCompletionFailurePayloads', { failureId, result });
}

/**
 * Delete a record's payload; returns whether there was one. A record has at
 * most one, so this reads at most one document.
 */
export async function deleteCompletionFailurePayload(
	ctx: MutationCtx,
	failureId: Id<'sendCompletionFailures'>
): Promise<boolean> {
	const payload = await payloadOf(ctx, failureId);
	if (payload) await ctx.db.delete(payload._id);
	return payload !== null;
}

async function resolveRow(
	ctx: MutationCtx,
	row: FailureRow,
	resolution: 'replayed' | 'superseded',
	now: number,
	feedbackRefusals: FailureRow['feedbackRefusals']
): Promise<void> {
	await deleteCompletionFailurePayload(ctx, row._id);
	await ctx.db.patch(row._id, {
		status: 'resolved',
		resolution,
		resolvedAt: now,
		pendingFeedback: undefined,
		nextReplayAt: undefined,
		...(feedbackRefusals?.length ? { feedbackRefusals } : {}),
	});
}

/**
 * Before a provider event is applied to a `queued` Send, replay any completion
 * recorded for it, so the event lands on the state the provider already
 * reported. Never throws: a replay that fails again leaves the record as it was.
 */
async function replayRecordedCompletion(
	ctx: MutationCtx,
	sendRef: CountableSendRef
): Promise<void> {
	const send = await ctx.db.get(sendRef.id);
	if (send?.status !== 'queued') return;
	for (const row of await unresolvedCompletionFailures(ctx, sendRef.id)) {
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

/**
 * Apply provider feedback to a Send that may have a recorded completion: replay
 * the record first, apply the event through `apply` (the entry point's own
 * lifecycle call, with its own identity and edge rules), and park the event on
 * the record if the lifecycle still refuses it against `queued`.
 */
export async function applyProviderFeedback<Outcome extends { ok: boolean }>(
	ctx: MutationCtx,
	sendRef: CountableSendRef,
	transition: { to: string },
	apply: () => Promise<Outcome>
): Promise<Outcome> {
	await replayRecordedCompletion(ctx, sendRef);
	const outcome = await apply();
	if (!outcome.ok) await parkFeedbackOnRecordedCompletion(ctx, sendRef, transition);
	return outcome;
}

const refusalValidator = v.object({ to: v.string(), at: v.number(), reason: v.string() });

/**
 * Run one record as a single nested unit: the completion (when the Send is
 * still `queued`), then the provider events parked on it in provider-time
 * order. Any throw rolls all of it back, so a record never resolves with its
 * events applied to only part of what the provider reported. An event the
 * lifecycle refuses (a soft bounce stamped after a complaint, say) is returned
 * as a refusal for the record to keep.
 */
export const applyRecordedCompletion = internalMutation({
	args: { failureId: v.id('sendCompletionFailures') },
	returns: v.array(refusalValidator),
	handler: async (ctx, { failureId }) => {
		const row = await ctx.db.get(failureId);
		if (!row) return [];
		const send = await ctx.db.get(row.sendRef.id);
		const payload = send?.status === 'queued' ? await payloadOf(ctx, row._id) : null;
		if (payload) {
			await ctx.runMutation(internal.delivery.sendCompletion.applyCompletion, {
				workId: row.workId as WorkId,
				result: payload.result,
				context: { sendRef: row.sendRef },
			});
		}
		const refusals: Array<Infer<typeof refusalValidator>> = [];
		for (const { transition } of orderParkedFeedback(row.pendingFeedback ?? [])) {
			const outcome = await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: row.sendRef,
				transition,
			});
			if (!outcome.ok) {
				refusals.push({ to: transition.to, at: transition.at, reason: outcome.reason });
			}
		}
		// Applied: an operator running this by hand to see an error must not
		// leave the events for the next replay to apply a second time.
		if (row.pendingFeedback?.length) await ctx.db.patch(row._id, { pendingFeedback: undefined });
		return refusals;
	},
});

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
		const isQueued = send?.status === 'queued';
		// Settled elsewhere (a webhook, an operator) with nothing parked: done.
		if (!send || (!isQueued && !row.pendingFeedback?.length)) {
			await resolveRow(ctx, row, 'superseded', now, undefined);
			return 'superseded';
		}
		if (isQueued && !(await payloadOf(ctx, row._id))) {
			await ctx.db.patch(row._id, {
				status: 'exhausted',
				nextReplayAt: undefined,
				lastError: 'NO_STORED_RESULT',
			});
			return 'failed';
		}

		let refusals: FailureRow['feedbackRefusals'];
		try {
			refusals = await ctx.runMutation(
				internal.delivery.sendCompletionFailures.applyRecordedCompletion,
				{ failureId }
			);
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
				lastError: completionErrorCode(error),
				lastFailedAt: now,
			});
			logWarn('[SendCompletion] Replay failed', { failureId, trigger, replayAttempts });
			return 'failed';
		}
		if (refusals?.length) {
			logWarn('[SendCompletion] Parked provider events refused on replay', {
				failureId,
				refused: refusals.length,
			});
		}
		const resolution = isQueued ? 'replayed' : 'superseded';
		await resolveRow(ctx, row, resolution, now, refusals);
		return resolution;
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
