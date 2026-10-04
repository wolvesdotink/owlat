import { type Infer, v } from 'convex/values';
import type { WorkId } from '@convex-dev/workpool';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logError, logWarn } from '../lib/runtimeLog';
import type { countableSendRefValidator } from '../lib/validators/send';
import type { workpoolRunResultValidator } from '../schema/sendCompletionFailures';
import {
	orderParkedFeedback,
	parkFeedbackOnRecordedCompletion,
	unresolvedCompletionFailures,
} from './sendCompletionFeedback';
import { isSendWorkerOutcome, type SendWorkerOutcome } from './workerOutcome';
import {
	clampUtf8,
	compactRunResult,
	completionErrorCode,
	RECORD_MAX_BYTES,
	recordBytes,
	summarizeRunResult,
	type CompactResult,
	PAYLOAD_MAX_BYTES,
	payloadBytes,
} from './sendCompletionPayload';
import { governedRetryDelayMs } from './sendRetryPlan';

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
 *
 * Three dispositions:
 *   - a deferral or open acceptance the arm would have RE-ENTERED: the record
 *     re-enters the Send itself, here, through the same decision
 *     (`./sendRetryPlan`), so the envelope travels in the scheduler as it would
 *     have and is never stored. The record resolves as `retried`; what was lost
 *     is the arm's side observation (a deferral count).
 *   - a compact payload over `PAYLOAD_MAX_BYTES`: not stored; the record is
 *     `exhausted` with `PAYLOAD_TOO_LARGE` for an operator.
 *   - anything else: `open`, with the compact payload, for the replay cron.
 */
export async function recordCompletionFailure(
	ctx: MutationCtx,
	args: CompletionArgs,
	error: unknown
): Promise<void> {
	const now = Date.now();
	const { sendRef } = args.context;
	const { isProviderIdTooLong, ...summary } = summarizeRunResult(args.result);
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
			...(summary.providerType ? { providerType: summary.providerType } : {}),
		});
	}

	const existing = await ctx.db
		.query('sendCompletionFailures')
		.withIndex('by_work_id', (q) => q.eq('workId', args.workId))
		.first();
	const isSameRecord = existing !== null && existing.sendRef.id === sendRef.id;
	const replayAttempts = isSameRecord ? existing.replayAttempts : 0;

	const reentryDelayMs = send.status === 'queued' ? reentryDelay(args.result, now) : null;
	const compact = compactRunResult(args.result);
	// An outcome whose payload, or whose provider id, is too large to keep whole.
	const isTooLarge = isProviderIdTooLong || payloadBytes(compact.result) > PAYLOAD_MAX_BYTES;
	const planned =
		reentryDelayMs !== null
			? ({ status: 'resolved', resolution: 'retried', resolvedAt: now } as const)
			: isTooLarge
				? ({ status: 'exhausted', lastError: 'PAYLOAD_TOO_LARGE' } as const)
				: ({ status: 'open', nextReplayAt: now + replayDelayMs(replayAttempts) } as const);
	const planBytes = recordBytes({
		...(isSameRecord ? existing : {}),
		...summary,
		lastError,
		...planned,
		sendRef,
		workId: args.workId,
	});
	// Every string is bounded above, so this only catches a field added later:
	// the record keeps its outcome kind and waits for an operator.
	const isRecordTooLarge = planBytes > RECORD_MAX_BYTES;
	const disposition = isRecordTooLarge
		? ({ status: 'exhausted', lastError: 'PAYLOAD_TOO_LARGE' } as const)
		: planned;
	const fields = {
		...(isRecordTooLarge ? { outcomeKind: summary.outcomeKind } : summary),
		lastError,
		lastFailedAt: now,
		...disposition,
	};

	let failureId: Id<'sendCompletionFailures'>;
	if (isSameRecord) {
		failureId = existing._id;
		await ctx.db.patch(existing._id, {
			resolution: undefined,
			resolvedAt: undefined,
			nextReplayAt: undefined,
			...fields,
		});
	} else {
		failureId = await ctx.db.insert('sendCompletionFailures', {
			sendRef,
			contactId: send.contactId,
			workId: args.workId,
			replayAttempts: 0,
			firstFailedAt: now,
			...fields,
		});
	}
	if (disposition.status === 'open') await storePayload(ctx, failureId, compact);
	else await deleteCompletionFailurePayload(ctx, failureId);
	if (disposition.status === 'resolved' && reentryDelayMs !== null) {
		const outcome = (args.result as { returnValue: RetryableOutcome }).returnValue;
		await ctx.scheduler.runAfter(reentryDelayMs, internal.delivery.sendCompletion.retrySend, {
			sendRef,
			envelopeInput: outcome.envelopeInput,
			retryState: outcome.retryState,
		});
	}
	logError('[SendCompletion] Completion failed; outcome recorded', {
		disposition: disposition.status,
		failureId,
		workId: args.workId,
		sendKind: sendRef.kind,
		sendId: sendRef.id,
		outcomeKind: summary.outcomeKind,
	});
}

/** The one payload row of a record, or null. Reads one document of at most 32 KiB. */
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
	{ result, isEnvelopeStripped }: CompactResult
): Promise<void> {
	const existing = await payloadOf(ctx, failureId);
	if (existing) await ctx.db.patch(existing._id, { result, isEnvelopeStripped });
	else {
		await ctx.db.insert('sendCompletionFailurePayloads', { failureId, result, isEnvelopeStripped });
	}
}

type RetryableOutcome = Extract<SendWorkerOutcome, { kind: 'deferred' | 'acceptanceUnknown' }>;

/** The re-entry delay the arm would have scheduled, or null when it terminalizes. */
function reentryDelay(result: RunResult, now: number): number | null {
	if (result.kind !== 'success') return null;
	const outcome: unknown = result.returnValue;
	if (!isSendWorkerOutcome(outcome)) return null;
	if (outcome.kind !== 'deferred' && outcome.kind !== 'acceptanceUnknown') return null;
	return governedRetryDelayMs(outcome, now);
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

export async function resolveCompletionFailure(
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
	// ONE record inline, so the event's own transaction reads one payload at
	// most; any others replay in their own. A failed nested replay keeps the
	// reads it made, which is why this is not a loop.
	const [first, ...rest] = await unresolvedCompletionFailures(ctx, sendRef.id);
	for (const row of rest) {
		await ctx.scheduler.runAfter(
			0,
			internal.delivery.sendCompletionFailures.replayCompletionFailure,
			{ failureId: row._id, trigger: 'webhook' }
		);
	}
	if (!first) return;
	try {
		await ctx.runMutation(internal.delivery.sendCompletionFailures.replayCompletionFailure, {
			failureId: first._id,
			trigger: 'webhook',
		});
	} catch {
		logError('[SendCompletion] Replay before provider event failed', { failureId: first._id });
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
				isEnvelopeStripped: payload.isEnvelopeStripped,
				context: { sendRef: row.sendRef },
			});
		}
		return await applyParkedFeedback(ctx, row);
	},
});

/**
 * Apply a record's parked provider events in provider-time order and clear
 * them, returning the ones the lifecycle refused. The one path for a replay
 * and for an operator closing a record by hand: once applied, the events are
 * gone, so nothing applies them a second time.
 */
export async function applyParkedFeedback(
	ctx: MutationCtx,
	row: FailureRow
): Promise<Array<Infer<typeof refusalValidator>>> {
	const refusals: Array<Infer<typeof refusalValidator>> = [];
	for (const { transition } of orderParkedFeedback(row.pendingFeedback ?? [])) {
		const outcome = await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
			send: row.sendRef,
			transition,
		});
		if (!outcome.ok) {
			refusals.push({
				to: transition.to,
				at: transition.at,
				reason: clampUtf8(outcome.reason, 100),
			});
		}
	}
	if (row.pendingFeedback?.length) await ctx.db.patch(row._id, { pendingFeedback: undefined });
	return refusals;
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
		const isQueued = send?.status === 'queued';
		// Settled elsewhere (a webhook, an operator) with nothing parked: done.
		if (!send || (!isQueued && !row.pendingFeedback?.length)) {
			await resolveCompletionFailure(ctx, row, 'superseded', now, undefined);
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
		await resolveCompletionFailure(ctx, row, resolution, now, refusals);
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
