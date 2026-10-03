import { type Infer, v } from 'convex/values';
import type { WorkId } from '@convex-dev/workpool';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logError, logWarn } from '../lib/runtimeLog';
import type { countableSendRefValidator } from '../lib/validators/send';
import type {
	parkedFeedbackTransitionValidator,
	workpoolRunResultValidator,
} from '../schema/sendCompletionFailures';
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
//     (`replayRecordedCompletion`); when that replay fails too, a terminal or
//     delivery event is PARKED on the record (`parkFeedbackOnRecordedCompletion`)
//     and applied right after the completion once a replay succeeds, so an early
//     bounce is never lost to the `queued` state;
//   - contact erasure deletes a Send's records when it scrubs the Send
//     (`deleteCompletionFailuresForSend`);
//   - operators read and re-open records in `./sendCompletionFailureAdmin`.
//
// NOTHING HERE CAN DOUBLE-COUNT. A replay re-runs the same completion, and every
// arm of it either goes through the Send lifecycle (which reports a repeat as a
// duplicate or refuses it, never applies it twice) or checks that the Send is
// still `queued` first. A record whose Send has already left `queued` only
// applies the events parked on it, then resolves as `superseded`. A parked event
// is stored once even when the provider re-delivers it.
// ============================================================================

type CountableSendRef = Infer<typeof countableSendRefValidator>;
type RunResult = Infer<typeof workpoolRunResultValidator>;
type ParkedTransition = Infer<typeof parkedFeedbackTransitionValidator>;
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
const ERROR_TEXT_MAX_LENGTH = 500;
/** A provider re-delivers a handful of events per message, not dozens. */
const PARKED_FEEDBACK_LIMIT = 20;

/** 10 min, 20, 40 … capped at 6 h: about a day and a half over the whole cap. */
function replayDelayMs(attempts: number): number {
	return Math.min(REPLAY_BASE_DELAY_MS * 2 ** attempts, REPLAY_MAX_DELAY_MS);
}

const EMAIL_ADDRESS = /[^\s@"'<>(),;:[\]]+@[^\s@"'<>(),;:[\]]+/g;

/**
 * What of an error is kept on the record. A Convex validation error quotes the
 * whole document it refused after its first line, and that document can carry
 * the recipient, their name and the message, so only the first line is kept,
 * with anything shaped like an address redacted.
 */
export function storableErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = (message.split('\n').find((line) => line.trim() !== '') ?? '').trim();
	const redacted = firstLine.replace(EMAIL_ADDRESS, '[address]');
	return redacted.length > ERROR_TEXT_MAX_LENGTH
		? `${redacted.slice(0, ERROR_TEXT_MAX_LENGTH)}…`
		: redacted;
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
	const lastError = storableErrorText(error);
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
		pendingFeedback: undefined,
		nextReplayAt: undefined,
	});
}

async function rowsForSend(
	ctx: MutationCtx,
	sendId: CountableSendRef['id']
): Promise<FailureRow[]> {
	return await ctx.db
		.query('sendCompletionFailures')
		.withIndex('by_send', (q) => q.eq('sendRef.id', sendId))
		.take(10);
}

const unresolved = (rows: FailureRow[]): FailureRow[] =>
	rows.filter((row) => row.status !== 'resolved');

/**
 * Before a provider event is applied to a `queued` Send, replay any completion
 * recorded for it, so the event lands on the state the provider already
 * reported. Never throws: a replay that fails again leaves the record as it was.
 */
export async function replayRecordedCompletion(
	ctx: MutationCtx,
	sendRef: CountableSendRef
): Promise<void> {
	const send = await ctx.db.get(sendRef.id);
	if (send?.status !== 'queued') return;
	for (const row of unresolved(await rowsForSend(ctx, sendRef.id))) {
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

function isParkable(transition: { to: string }): transition is ParkedTransition {
	return (
		transition.to === 'bounced' ||
		transition.to === 'complained' ||
		transition.to === 'delivered' ||
		transition.to === 'failed'
	);
}

/** A provider re-delivery: same edge, same event time, same bounce class. */
function isSameEvent(a: ParkedTransition, b: ParkedTransition): boolean {
	if (a.to !== b.to || a.at !== b.at) return false;
	return a.to !== 'bounced' || b.to !== 'bounced' || a.bounceType === b.bounceType;
}

/**
 * Keep a provider event the lifecycle just refused because the Send is still
 * `queued` behind an unrecorded completion. The replay applies it after the
 * completion. Returns whether it was kept.
 *
 * WHY PARK INSTEAD OF ANSWERING 5xx. A retryable answer would ask the provider
 * to hold the event for us, and providers differ: SNS gives an HTTP endpoint a
 * few retries over minutes, while a fix may take a day; Mandrill and Svix batch
 * several events in one delivery, so the whole batch would come back and the
 * non-idempotent opens and clicks in it would count twice. Parking keeps the
 * event in our own database for exactly as long as the record lives.
 */
export async function parkFeedbackOnRecordedCompletion(
	ctx: MutationCtx,
	sendRef: CountableSendRef,
	transition: { to: string }
): Promise<boolean> {
	if (!isParkable(transition)) return false;
	const send = await ctx.db.get(sendRef.id);
	if (send?.status !== 'queued') return false;
	const row = unresolved(await rowsForSend(ctx, sendRef.id))[0];
	if (!row) return false;
	const parked = row.pendingFeedback ?? [];
	if (parked.some((event) => isSameEvent(event.transition, transition))) return true;
	if (parked.length >= PARKED_FEEDBACK_LIMIT) {
		logWarn('[SendCompletion] Parked provider events full; event dropped', {
			failureId: row._id,
			edge: transition.to,
		});
		return false;
	}
	await ctx.db.patch(row._id, {
		pendingFeedback: [...parked, { transition, receivedAt: Date.now() }],
	});
	return true;
}

/**
 * Contact erasure: delete every record of a Send it scrubs. Returns the deleted
 * rows so the caller can charge them to its budget.
 */
export async function deleteCompletionFailuresForSend(
	ctx: MutationCtx,
	sendId: CountableSendRef['id']
): Promise<FailureRow[]> {
	const rows = await rowsForSend(ctx, sendId);
	for (const row of rows) await ctx.db.delete(row._id);
	return rows;
}

/**
 * Run one record as a single nested unit: the completion (when the Send is
 * still `queued`), then the provider events parked on it, oldest first. Any
 * throw rolls all of it back, so a record never resolves with its events
 * applied to only half of what the provider reported.
 */
export const applyRecordedCompletion = internalMutation({
	args: { failureId: v.id('sendCompletionFailures') },
	handler: async (ctx, { failureId }) => {
		const row = await ctx.db.get(failureId);
		if (!row) return;
		const send = await ctx.db.get(row.sendRef.id);
		if (send?.status === 'queued' && row.result) {
			await ctx.runMutation(internal.delivery.sendCompletion.applyCompletion, {
				workId: row.workId as WorkId,
				result: row.result,
				context: { sendRef: row.sendRef },
			});
		}
		for (const event of row.pendingFeedback ?? []) {
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: row.sendRef,
				transition: event.transition,
			});
		}
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
			await resolveRow(ctx, row, 'superseded', now);
			return 'superseded';
		}
		if (isQueued && !row.result) {
			await ctx.db.patch(row._id, {
				status: 'exhausted',
				nextReplayAt: undefined,
				lastError: 'No stored result to replay',
			});
			return 'failed';
		}

		try {
			await ctx.runMutation(internal.delivery.sendCompletionFailures.applyRecordedCompletion, {
				failureId,
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
				lastError: storableErrorText(error),
				lastFailedAt: now,
			});
			logWarn('[SendCompletion] Replay failed', { failureId, trigger, replayAttempts });
			return 'failed';
		}
		const resolution = isQueued ? 'replayed' : 'superseded';
		await resolveRow(ctx, row, resolution, now);
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
