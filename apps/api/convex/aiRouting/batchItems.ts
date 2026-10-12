/**
 * Provider batch items (ADR-0073, L14; Phase 5): one non-interactive model
 * request sent through a provider's batch API while the routing policy's
 * `batchApi` switch is `enforce`. Off (the default), nothing here runs and
 * every consumer makes today's real-time call.
 *
 * Every item is reserved and settled exactly once:
 *
 *   - {@link admitItem} decides, holds and records the item in ONE mutation
 *     (`reserveInMutation`): the hold covers the one request at its full
 *     real-time price, so a batch can never spend past the ceiling. A source
 *     with a live item gets no second one; a source whose item is over goes
 *     back to the real-time path.
 *   - EVERY terminal transition writes the request's ONE ledger row, and then
 *     settles its hold when there is one, in the same mutation
 *     ({@link writeItemRow}): the reported usage when the provider ran it
 *     ({@link completeItem}); zero when the request's own record says it was
 *     not billed ({@link failItem}, a submission the provider refused); and the
 *     item's full bound, `requestBoundMicrousd`, when whether it was billed is
 *     unknown (a submission the provider may have taken, a result that never
 *     came, a result line that is missing or malformed: {@link abandonItem}).
 *     The bound is stored on the item, so this holds with no ceiling
 *     configured, when admission held nothing. The transition is the status
 *     check in the same mutation, so a second poll changes nothing, and the
 *     row is idempotent by request id and attempt too. A hold the expiry
 *     sweep already charged is offset by the row (`reconcileLateRow`).
 *
 * The work itself continues through the paths that already exist: a result
 * becomes the extraction's `in_progress` marker, which the re-run extraction
 * saves (`knowledge/extractionProgress.ts`), or the summary a re-run file
 * processing uses; an item that produced nothing usable hands its source back
 * to the real-time path once.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalQuery, type MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { llmRootContextValidator } from '../lib/llmUsageTags';
import { batchConsumerValidator, batchProviderValidator } from '../lib/validators/aiRouting';
import { taskPolicy } from '../lib/llm/taskPolicy';
import {
	BATCH_CONSUMER_SPECS,
	BATCH_ITEM_LIFETIME_MS,
	BATCH_POLL_INTERVAL_MS,
	BATCH_SUBMIT_GRACE_MS,
	batchEndpoint,
	batchItemKey,
} from '../lib/aiRouting/batchConsumers';
import { meteredRequestValidator, type MeteredRequest } from '../analytics/llmUsage';
import { insertLlmUsage, ZERO_USAGE } from '../analytics/ledgerInsert';
import { extractedEntryValidator } from '../schema/aiRouting';
import { loadRoutingPolicy } from './policy';
import { continueWith, handBack } from './batchContinuation';
import { batchedFileSummaryValidator } from '../analytics/backgroundDeferral';
import { reserveInMutation } from './admission';
import { reconcileLateRow, settleReservation } from './settlement';

const LIVE_STATUSES = new Set(['submitting', 'submitted']);

const refusedValidator = v.object({
	kind: v.literal('refused'),
	reason: v.union(
		v.literal('daily_ceiling'),
		v.literal('monthly_ceiling'),
		v.literal('spend_unverifiable')
	),
	limit: v.string(),
});

/**
 * Hold and record one batch request. `off`: the switch is not `enforce` (read
 * here, in the transaction that would hold); `pending`: the source already has
 * a live item, so nothing is sent again; `used`: its item is over, so the
 * caller goes real-time; `refused`: admission said no, as it would for the
 * real-time call.
 */
export const admitItem = internalMutation({
	args: {
		consumer: batchConsumerValidator,
		sourceId: v.string(),
		provider: batchProviderValidator,
		modelId: v.string(),
		requestId: v.string(),
		reservationId: v.string(),
		root: llmRootContextValidator,
		/** The request's bound, integer micro-USD, at the full real-time price. */
		holdMicrousd: v.number(),
	},
	returns: v.union(
		v.object({ kind: v.literal('admitted'), itemId: v.id('llmBatchItems') }),
		v.object({ kind: v.union(v.literal('off'), v.literal('pending'), v.literal('used')) }),
		refusedValidator
	),
	handler: async (ctx, args) => {
		const itemKey = batchItemKey(args.consumer, args.sourceId);
		const latest = await ctx.db
			.query('llmBatchItems')
			.withIndex('by_item_key', (q) => q.eq('itemKey', itemKey))
			.order('desc')
			.first();
		if (latest) return { kind: LIVE_STATUSES.has(latest.status) ? 'pending' : 'used' } as const;
		const policy = await loadRoutingPolicy(ctx);
		if (policy.batchApi !== 'enforce') return { kind: 'off' } as const;

		const { task } = BATCH_CONSUMER_SPECS[args.consumer];
		const entry = taskPolicy(task);
		const now = Date.now();
		const expiresAt = now + BATCH_ITEM_LIFETIME_MS;
		const verdict = await reserveInMutation(ctx, {
			reservationId: args.reservationId,
			rootRequestId: args.root.rootRequestId,
			...(args.root.parentCallId ? { parentCallId: args.root.parentCallId } : {}),
			plane: entry.plane,
			task,
			budgetClass: entry.budgetClass,
			priority: args.root.priority ?? entry.priority,
			heldMicrousd: args.holdMicrousd,
			maxRequests: 1,
			requestBound: { requestId: args.requestId, attempt: 1, microusd: args.holdMicrousd },
			modelId: args.modelId,
			endpoint: args.provider,
			expiresAt,
		});
		if (!verdict.isAdmitted) {
			return { kind: 'refused', reason: verdict.reason, limit: verdict.limit } as const;
		}
		const itemId = await ctx.db.insert('llmBatchItems', {
			itemKey,
			consumer: args.consumer,
			sourceId: args.sourceId,
			task,
			provider: args.provider,
			modelId: args.modelId,
			requestId: args.requestId,
			rootRequestId: args.root.rootRequestId,
			...(args.root.parentCallId ? { parentCallId: args.root.parentCallId } : {}),
			policyVersion: policy.policyVersion,
			requestBoundMicrousd: args.holdMicrousd,
			// No ceiling configured: admission held nothing, and the row alone is written.
			...(verdict.isHeld ? { reservationId: args.reservationId } : {}),
			status: 'submitting',
			// An unconfirmed submission is looked at once its grace is over.
			nextPollAt: now + BATCH_SUBMIT_GRACE_MS,
			expiresAt,
			createdAt: now,
			updatedAt: now,
		});
		return { kind: 'admitted', itemId } as const;
	},
});

/** The provider took the batch: poll it from now on. */
export const confirmSubmitted = internalMutation({
	args: {
		itemId: v.id('llmBatchItems'),
		providerBatchId: v.string(),
		providerFileId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item) return;
		const now = Date.now();
		const ids = {
			providerBatchId: args.providerBatchId,
			...(args.providerFileId ? { providerFileId: args.providerFileId } : {}),
			updatedAt: now,
		};
		// Abandoned meanwhile (the confirmation came after the grace): its hold
		// is already left to the sweep; keep the ids for the record only.
		if (item.status !== 'submitting') {
			await ctx.db.patch(item._id, ids);
			return;
		}
		await ctx.db.patch(item._id, {
			...ids,
			status: 'submitted',
			nextPollAt: now + BATCH_POLL_INTERVAL_MS,
		});
	},
});

/**
 * The submission failed. `isDefinite`: the provider created nothing, so the
 * request's row is zero; otherwise the batch may exist and the row is the
 * item's full bound. The caller goes real-time itself.
 */
export const refuseSubmission = internalMutation({
	args: { itemId: v.id('llmBatchItems'), isDefinite: v.boolean() },
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item || item.status !== 'submitting') return;
		if (args.isDefinite) {
			await writeItemRow(ctx, item, { kind: 'unbilled' });
			await close(ctx, item, 'failed', 'errored');
		} else {
			await writeItemRow(ctx, item, { kind: 'unknown' });
			await close(ctx, item, 'abandoned', 'lost');
		}
	},
});

/** Submitted items due for a poll, and submissions never confirmed within their grace. */
export const duePolls = internalQuery({
	args: { limit: v.number() },
	handler: async (ctx, args) => {
		const now = Date.now();
		const due = async (status: 'submitting' | 'submitted') =>
			ctx.db
				.query('llmBatchItems')
				.withIndex('by_status_and_next_poll', (q) => q.eq('status', status).lte('nextPollAt', now))
				.take(args.limit);
		const [unconfirmed, submitted] = await Promise.all([due('submitting'), due('submitted')]);
		return [...unconfirmed, ...submitted].slice(0, args.limit);
	},
});

/**
 * The cron's entry: start the (Node) poller only when an item is due, so a
 * deployment with the switch off, or nothing out, runs no action for it.
 */
export const kickPoller = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		for (const status of ['submitting', 'submitted'] as const) {
			const due = await ctx.db
				.query('llmBatchItems')
				.withIndex('by_status_and_next_poll', (q) => q.eq('status', status).lte('nextPollAt', now))
				.first();
			if (due) {
				await ctx.scheduler.runAfter(0, internal.aiRouting.batchPoller.poll, {});
				return;
			}
		}
	},
});

/** Not ended yet: ask again later. */
export const postponePoll = internalMutation({
	args: { itemId: v.id('llmBatchItems') },
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item || item.status !== 'submitted') return;
		const now = Date.now();
		await ctx.db.patch(item._id, { nextPollAt: now + BATCH_POLL_INTERVAL_MS, updatedAt: now });
	},
});

/**
 * The provider ran the request: write its ledger row and settle its hold, in
 * this mutation, then hand the result on. `succeeded` carries the parsed
 * output (the extraction's entries, or the summary); `truncated` and
 * `invalid` were billed but give nothing usable, so the source goes back to
 * the real-time path once. Returns whether this call closed the item.
 */
export const completeItem = internalMutation({
	args: {
		itemId: v.id('llmBatchItems'),
		outcome: v.union(v.literal('succeeded'), v.literal('truncated'), v.literal('invalid')),
		/** The billed request as the dispatch read it; absent: its usage is unknown. */
		request: v.optional(meteredRequestValidator),
		entries: v.optional(v.array(extractedEntryValidator)),
		summary: v.optional(batchedFileSummaryValidator),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item || item.status !== 'submitted') return false;
		await writeItemRow(
			ctx,
			item,
			args.request?.usage ? { kind: 'reported', request: args.request } : { kind: 'unknown' }
		);
		await close(ctx, item, 'completed', args.outcome);
		if (args.outcome !== 'succeeded') {
			await handBack(ctx, item);
			return true;
		}
		await continueWith(ctx, item, args);
		return true;
	},
});

/**
 * The request's own result record says it was not billed (errored, expired,
 * cancelled): a zero row, the hold settled at zero, and the source goes
 * real-time.
 */
export const failItem = internalMutation({
	args: {
		itemId: v.id('llmBatchItems'),
		outcome: v.union(v.literal('errored'), v.literal('expired'), v.literal('canceled')),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item || item.status !== 'submitted') return false;
		await writeItemRow(ctx, item, { kind: 'unbilled' });
		await close(ctx, item, 'failed', args.outcome);
		await handBack(ctx, item);
		return true;
	},
});

/**
 * Owlat lost track of the item: a submission never confirmed, no result by its
 * expiry, or an ended batch without a usable line for it. Whether the provider
 * billed it is unknown, so its row charges the item's full bound, and the
 * source goes back to the real-time path.
 */
export const abandonItem = internalMutation({
	args: { itemId: v.id('llmBatchItems') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item || !LIVE_STATUSES.has(item.status)) return false;
		await writeItemRow(ctx, item, { kind: 'unknown' });
		await close(ctx, item, 'abandoned', 'lost');
		await handBack(ctx, item);
		return true;
	},
});

async function close(
	ctx: MutationCtx,
	item: Doc<'llmBatchItems'>,
	status: 'completed' | 'failed' | 'abandoned',
	outcome: NonNullable<Doc<'llmBatchItems'>['outcome']>
): Promise<void> {
	await ctx.db.patch(item._id, { status, outcome, updatedAt: Date.now() });
}

/**
 * What one item's request came to: `reported` usage; `unbilled`, by the
 * provider's own evidence; or `unknown`, charged at the item's full bound.
 */
type ItemCharge =
	| { readonly kind: 'reported'; readonly request: MeteredRequest }
	| { readonly kind: 'unbilled' }
	| { readonly kind: 'unknown' };

/**
 * Write the item's one ledger row, then settle its hold (when admission held
 * one) against it. Idempotent: a row already written for the request is kept.
 */
async function writeItemRow(
	ctx: MutationCtx,
	item: Doc<'llmBatchItems'>,
	charge: ItemCharge
): Promise<void> {
	const existing = await ctx.db
		.query('llmUsageEvents')
		.withIndex('by_request_id_and_attempt', (q) =>
			q.eq('requestId', item.requestId).eq('attempt', 1)
		)
		.first();
	if (!existing) {
		const request = charge.kind === 'reported' ? charge.request : undefined;
		const { usage, modelUsed, attempt: _attempt, latencyMs: _latency, ...details } = request ?? {};
		const inserted = await insertLlmUsage(
			ctx,
			BATCH_CONSUMER_SPECS[item.consumer].feature,
			usage ?? ZERO_USAGE,
			modelUsed ?? item.modelId,
			undefined,
			{
				...details,
				plane: 'language',
				task: item.task,
				requestId: item.requestId,
				attempt: 1,
				rootRequestId: item.rootRequestId,
				...(item.parentCallId ? { parentCallId: item.parentCallId } : {}),
				policyVersion: item.policyVersion,
				endpoint: batchEndpoint(item.provider),
				// The request's turnaround through the batch.
				latencyMs: Math.max(0, Date.now() - item.createdAt),
				...(item.reservationId ? { reservationId: item.reservationId } : {}),
				...(charge.kind === 'unknown'
					? { settledEstimateMicrousd: item.requestBoundMicrousd }
					: { isEstimated: false }),
			}
		);
		// A hold the expiry sweep already charged takes the row against its charge.
		if (item.reservationId) await reconcileLateRow(ctx, item.reservationId, inserted);
	}
	if (item.reservationId) {
		await settleReservation(ctx, item.reservationId, { mode: 'call_end', expectedRequests: 1 });
	}
}
