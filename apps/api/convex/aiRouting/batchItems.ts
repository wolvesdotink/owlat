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
 *   - Only the transition out of `submitted` writes the request's ledger row
 *     and settles its hold ({@link completeItem}), or releases it when the
 *     provider billed nothing ({@link failItem}), and the transition is the
 *     status check in the same mutation, so a second poll changes nothing.
 *     `writeRequestBatch` is idempotent by request id too.
 *   - A submission the provider may or may not have taken, or a result that
 *     never came, is `abandoned`: its hold stays held and the expiry sweep
 *     charges it in full (`aiRouting/admission.ts`). A late row is offset
 *     against that charge (`reconcileLateRow`).
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
import {
	batchConsumerValidator,
	batchProviderValidator,
	type BatchConsumer,
} from '../lib/validators/aiRouting';
import { taskPolicy } from '../lib/llm/taskPolicy';
import {
	BATCH_CONSUMER_SPECS,
	BATCH_ITEM_LIFETIME_MS,
	BATCH_POLL_INTERVAL_MS,
	BATCH_SUBMIT_GRACE_MS,
	batchEndpoint,
	batchItemKey,
} from '../lib/aiRouting/batchConsumers';
import { meteredRequestValidator, writeRequestBatch } from '../analytics/llmUsage';
import { extractedEntryValidator } from '../schema/aiRouting';
import {
	readExtractionProgress,
	writeExtractionMarker,
	type ExtractionSourceType,
} from '../knowledge/extractionProgress';
import { loadRoutingPolicy } from './policy';
import {
	batchedFileSummaryValidator,
	type BatchedFileSummary,
} from '../analytics/backgroundDeferral';
import { reserveInMutation } from './admission';
import { settleReservation } from './settlement';

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
 * hold is released; otherwise the batch may exist and the hold is left for
 * the sweep. The caller goes real-time itself.
 */
export const refuseSubmission = internalMutation({
	args: { itemId: v.id('llmBatchItems'), isDefinite: v.boolean() },
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item || item.status !== 'submitting') return;
		if (args.isDefinite) {
			await releaseHold(ctx, item);
			await close(ctx, item, 'failed', 'errored');
		} else {
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
		const now = Date.now();
		const { feature } = BATCH_CONSUMER_SPECS[item.consumer];
		await writeRequestBatch(ctx, {
			feature,
			task: item.task,
			requestId: item.requestId,
			rootRequestId: item.rootRequestId,
			...(item.parentCallId ? { parentCallId: item.parentCallId } : {}),
			policyVersion: item.policyVersion,
			plane: 'language',
			...(item.reservationId ? { reservationId: item.reservationId } : {}),
			requests: [
				{
					...args.request,
					attempt: 1,
					// The request's turnaround through the batch.
					latencyMs: Math.max(0, now - item.createdAt),
					modelUsed: args.request?.modelUsed ?? item.modelId,
					endpoint: batchEndpoint(item.provider),
				},
			],
			...(item.reservationId
				? { settlements: [{ reservationId: item.reservationId, expectedRequests: 1 }] }
				: {}),
		});
		await close(ctx, item, 'completed', args.outcome);
		if (args.outcome !== 'succeeded') {
			await handBack(ctx, item);
			return true;
		}
		await continueWith(ctx, item, args);
		return true;
	},
});

/** The provider ran nothing it bills for (errored, expired, cancelled): release and go real-time. */
export const failItem = internalMutation({
	args: {
		itemId: v.id('llmBatchItems'),
		outcome: v.union(v.literal('errored'), v.literal('expired'), v.literal('canceled')),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item || item.status !== 'submitted') return false;
		await releaseHold(ctx, item);
		await close(ctx, item, 'failed', args.outcome);
		await handBack(ctx, item);
		return true;
	},
});

/**
 * Owlat lost track of the item: a submission never confirmed, no result by its
 * expiry, or an ended batch without its line. Whether the provider billed it
 * is unknown, so its hold is left for the expiry sweep to charge in full, and
 * the source goes back to the real-time path.
 */
export const abandonItem = internalMutation({
	args: { itemId: v.id('llmBatchItems') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const item = await ctx.db.get(args.itemId);
		if (!item || !LIVE_STATUSES.has(item.status)) return false;
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

/** Release the item's hold: the provider billed nothing for it. */
async function releaseHold(ctx: MutationCtx, item: Doc<'llmBatchItems'>): Promise<void> {
	if (item.reservationId) {
		await settleReservation(ctx, item.reservationId, { mode: 'call_end', expectedRequests: 0 });
	}
}

const EXTRACTION_SOURCE: Readonly<
	Record<Exclude<BatchConsumer, 'file_summary'>, ExtractionSourceType>
> = {
	knowledge_message: 'agent_extracted',
	knowledge_file: 'file',
	knowledge_mail: 'email',
};

/** The source's own document id, when it still exists. */
async function liveSourceId(
	ctx: MutationCtx,
	item: Doc<'llmBatchItems'>
): Promise<
	| { consumer: 'knowledge_message'; id: Doc<'inboundMessages'>['_id'] }
	| { consumer: 'knowledge_file' | 'file_summary'; id: Doc<'semanticFiles'>['_id'] }
	| { consumer: 'knowledge_mail'; id: Doc<'mailMessages'>['_id'] }
	| null
> {
	switch (item.consumer) {
		case 'knowledge_message': {
			const id = ctx.db.normalizeId('inboundMessages', item.sourceId);
			return id && (await ctx.db.get(id)) ? { consumer: item.consumer, id } : null;
		}
		case 'knowledge_file':
		case 'file_summary': {
			const id = ctx.db.normalizeId('semanticFiles', item.sourceId);
			return id && (await ctx.db.get(id)) ? { consumer: item.consumer, id } : null;
		}
		case 'knowledge_mail': {
			const id = ctx.db.normalizeId('mailMessages', item.sourceId);
			return id && (await ctx.db.get(id)) ? { consumer: item.consumer, id } : null;
		}
	}
}

/**
 * Run the source's consumer again, now (`summary`: with the batch's summary).
 * A source deleted meanwhile is left alone. The re-run finds the item over,
 * so anything it still has to ask a model goes real-time.
 */
async function rerun(
	ctx: MutationCtx,
	item: Doc<'llmBatchItems'>,
	summary?: BatchedFileSummary
): Promise<void> {
	const source = await liveSourceId(ctx, item);
	if (!source) return;
	switch (source.consumer) {
		case 'knowledge_message':
			await ctx.scheduler.runAfter(0, internal.knowledge.extraction.extractFromMessage, {
				inboundMessageId: source.id,
			});
			return;
		case 'knowledge_file':
			await ctx.scheduler.runAfter(0, internal.knowledge.extraction.extractFromFile, {
				fileId: source.id,
			});
			return;
		case 'knowledge_mail':
			await ctx.scheduler.runAfter(0, internal.knowledge.batchedMail.resumeMailExtraction, {
				mailMessageId: source.id,
			});
			return;
		case 'file_summary':
			await ctx.scheduler.runAfter(0, internal.semanticFileProcessing.processFile, {
				fileId: source.id,
				...(summary ? { batchedSummary: summary } : {}),
			});
			return;
	}
}

/** Nothing usable came back: the source goes to the real-time path, once. */
async function handBack(ctx: MutationCtx, item: Doc<'llmBatchItems'>): Promise<void> {
	await rerun(ctx, item);
}

/** A usable result: continue the source's work with it. */
async function continueWith(
	ctx: MutationCtx,
	item: Doc<'llmBatchItems'>,
	result: {
		entries?: Doc<'knowledgeExtractionProgress'>['entries'];
		summary?: BatchedFileSummary;
	}
): Promise<void> {
	if (item.consumer === 'file_summary') {
		if (result.summary) await rerun(ctx, item, result.summary);
		else await handBack(ctx, item);
		return;
	}
	const entries = result.entries ?? [];
	// No entries: the real-time call would have stopped here too.
	if (entries.length === 0) return;
	if (!(await liveSourceId(ctx, item))) return;
	const sourceType = EXTRACTION_SOURCE[item.consumer];
	const progress = await readExtractionProgress(ctx, sourceType, item.sourceId);
	// Another run got there first (a real-time run while this was out): keep its.
	if (progress.isDone || progress.isPartial) return;
	// The marker a resumed extraction saves without asking the model again.
	await writeExtractionMarker(ctx, sourceType, item.sourceId, 'in_progress', entries);
	await rerun(ctx, item);
}
