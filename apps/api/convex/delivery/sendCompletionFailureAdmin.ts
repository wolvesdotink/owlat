import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import {
	applyParkedFeedback,
	deleteCompletionFailurePayload,
	resolveCompletionFailure,
} from './sendCompletionFailures';

// ============================================================================
// Send completion failures — retention and the operator surface (#1195).
//
// The records themselves, their replay and parked provider events live in
// `./sendCompletionFailures`. This module deletes old records and gives an
// operator `npx convex run` access to the rest (apps/docs "Platform
// operations").
//
// READ BUDGET. A record row is at most `RECORD_MAX_BYTES` (8 KiB; every string
// in it is bounded at write, and the largest a test can build is under 4 KiB)
// and a payload at most `PAYLOAD_MAX_BYTES` (32 KiB). A delete re-reads what it
// deletes, so it counts twice. Worst case per transaction, against Convex's
// 16 MiB read limit:
//   - purge: 100 records x 16 KiB + 50 payloads x 64 KiB = 4.8 MiB
//     (measured: 3.2 MiB for 50 records with 31 KiB payloads)
//   - status: 2 x 200 records x 8 KiB = 3.2 MiB
//   - re-open: 100 records x 16 KiB = 1.6 MiB
//   - contact cleanup: 50 x (16 + 64) KiB = 4 MiB
//   - workspace sweep (`workspaces/deletion/steps/registry.ts`): 50 payloads x
//     64 KiB = 3.2 MiB, 100 records x 16 KiB = 1.6 MiB
//   - contact erasure walker: its 4 MiB byte budget, which charges each delete's
//     re-read (measured: 3.16 MiB read for 3.17 MiB charged)
// The replay cron reads 25 records (200 KiB), a replay one record and one
// payload, and a provider event replays one record inline.
// ============================================================================

type FailureRow = Doc<'sendCompletionFailures'>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A resolved record holds no outcome any more; it is kept for the audit trail. */
export const RESOLVED_RETENTION_MS = 30 * DAY_MS;
/** An exhausted record still holds the outcome an operator may want to replay. */
export const EXHAUSTED_RETENTION_MS = 90 * DAY_MS;
export const PURGE_BATCH_SIZE = 100;
/** Payloads deleted per purge transaction (see the read budget above). */
export const PURGE_PAYLOADS_PER_BATCH = 50;
/** Records per contact-cleanup transaction (see the read budget above). */
export const CONTACT_CLEANUP_BATCH_SIZE = 50;
const STATUS_COUNT_LIMIT = 200;
const STATUS_SAMPLE_SIZE = 20;

/**
 * Cron: delete resolved records 30 days and exhausted ones 90 days after their
 * last failure, with their payloads. One bounded batch per transaction, by
 * rows and by payloads; a full batch schedules the next, so a backlog drains in
 * one tick.
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
		let payloads = 0;
		let isFull = false;
		for (const [status, retentionMs] of retention) {
			const rows = await ctx.db
				.query('sendCompletionFailures')
				.withIndex('by_status_and_last_failed_at', (q) =>
					q.eq('status', status).lt('lastFailedAt', now - retentionMs)
				)
				.take(PURGE_BATCH_SIZE - deleted);
			for (const row of rows) {
				if (await deleteCompletionFailurePayload(ctx, row._id)) payloads += 1;
				await ctx.db.delete(row._id);
				deleted += 1;
				if (payloads >= PURGE_PAYLOADS_PER_BATCH) break;
			}
			isFull = deleted >= PURGE_BATCH_SIZE || payloads >= PURGE_PAYLOADS_PER_BATCH;
			if (isFull) break;
		}
		if (isFull) {
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
 * `npx convex run delivery/sendCompletionFailureAdmin:status`. Counts stop at
 * 200 (`isCountCapped`).
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
			isCountCapped: open.length === STATUS_COUNT_LIMIT || exhausted.length === STATUS_COUNT_LIMIT,
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

/**
 * Contact erasure's continuation for a contact with more records than one
 * inline erasure deletes (`contacts/erasure/phases.ts`): a bounded batch per
 * transaction, each record after its payload, rescheduled until none is left.
 * The records are found by `contactId`, so it finishes after the contact row is
 * gone, and no new record can appear: the contact's Sends are soft-deleted.
 */
export const deleteContactCompletionFailures = internalMutation({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, { contactId }) => {
		const rows = await ctx.db
			.query('sendCompletionFailures')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CONTACT_CLEANUP_BATCH_SIZE);
		for (const row of rows) {
			await deleteCompletionFailurePayload(ctx, row._id);
			await ctx.db.delete(row._id);
		}
		if (rows.length === CONTACT_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.sendCompletionFailureAdmin.deleteContactCompletionFailures,
				{ contactId }
			);
		}
		return { deleted: rows.length };
	},
});

/**
 * Operator: close a record the replay cannot finish, such as one stored as
 * `PAYLOAD_TOO_LARGE` or refused with `ENVELOPE_NOT_STORED`. `sent` needs the
 * provider id the record kept from an acceptance; `failed` ends the Send with
 * `SEND_COMPLETION_UNRECOVERABLE`, which says the outcome is unknown. Either
 * goes through the Send lifecycle, and only while the Send is still `queued`.
 *
 * Provider events parked on the record are applied right after, through the
 * same ordered path as a replay, all in this one transaction. After `sent` a
 * parked bounce or complaint lands as it would have; after `failed` the
 * lifecycle refuses them (a failed Send takes no more transitions), and they
 * are kept on the resolved record as refusals, not dropped silently. Close as
 * `sent` when `status` shows parked events and the record kept a provider id.
 */
export const closeCompletionFailure = internalMutation({
	args: {
		failureId: v.id('sendCompletionFailures'),
		outcome: v.union(v.literal('sent'), v.literal('failed')),
	},
	handler: async (ctx, { failureId, outcome }) => {
		const row = await ctx.db.get(failureId);
		if (!row || row.status === 'resolved') return { closed: false, reason: 'not_open' };
		const send = await ctx.db.get(row.sendRef.id);
		const now = Date.now();
		if (send?.status === 'queued') {
			const { providerMessageId, providerType } = row;
			if (outcome === 'sent' && !providerMessageId) {
				return { closed: false, reason: 'no_provider_message_id' };
			}
			const transition =
				providerMessageId && outcome === 'sent'
					? {
							to: 'sent' as const,
							at: now,
							providerMessageId,
							...(providerType ? { providerType } : {}),
						}
					: {
							to: 'failed' as const,
							at: now,
							errorMessage:
								'Closed by an operator after its completion could not be replayed; the message may or may not have been delivered',
							errorCode: 'SEND_COMPLETION_UNRECOVERABLE',
						};
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: row.sendRef,
				transition,
			});
		}
		const refusals = await applyParkedFeedback(ctx, row);
		await resolveCompletionFailure(ctx, row, 'superseded', now, refusals);
		return { closed: true, reason: null };
	},
});
