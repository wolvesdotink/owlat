'use node';

/**
 * The provider batch poller: asks each submitted batch item's
 * provider whether its batch has ended and, when it has, reads the item's
 * result line and closes the item through `./batchItems.ts`, which writes the
 * ledger row and settles the hold in one mutation. A cron runs it; it takes
 * one page of due items at a time and continues while more are due, a bounded
 * number of pages per run, so a backlog drains at a bounded rate.
 *
 * Runs whatever the switch says: an item submitted while `batchApi` was
 * `enforce` is still owed its result after the switch goes back off.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import { resolveAiConfig } from '../lib/llmProvider';
import { logWarn } from '../lib/runtimeLog';
import { secretFreeErrorText } from '../lib/embeddingSpace';
import { batchTransport, type BatchTransport } from '../lib/llm/batch/transport';
import { replayObjectResult, type BatchRoute } from '../lib/llm/batch/capture';
import { batchCallOf } from '../lib/llm/batch/calls';
import type { BatchState } from '../lib/llm/batch/wire';
import type { LlmRequestRecord } from '../lib/llm/requestMeter';
import { capPerMessage } from '../knowledge/extractionPolicy';
import type { MeteredRequest } from '../analytics/llmUsage';

/** Items polled per page. */
const PAGE = 25;
/** Pages one run takes before it leaves the rest to the next cron tick. */
const MAX_PAGES = 8;

type Item = Doc<'llmBatchItems'>;

/** The transport of the item's provider, when the current language plane is that provider. */
async function transportsByProvider(ctx: ActionCtx): Promise<Map<string, BatchTransport>> {
	const transports = new Map<string, BatchTransport>();
	try {
		const { language } = await resolveAiConfig(ctx);
		const apiKey = language.clientConfig.apiKey;
		if (apiKey && !language.clientConfig.baseUrl) {
			const provider = language.endpointProvenance;
			if (provider === 'openai-native' || provider === 'anthropic-native') {
				transports.set(provider, batchTransport(provider, apiKey));
			}
		}
	} catch {
		// No usable plane right now: every item waits for a later poll (or its expiry).
	}
	return transports;
}

function toMeteredRequest(record: LlmRequestRecord | undefined): MeteredRequest | undefined {
	if (!record) return undefined;
	const { outcome: _outcome, reservationId: _reservationId, ...request } = record;
	return request;
}

/** Read an ended batch's line for the item and close the item with it. */
async function closeEnded(
	ctx: ActionCtx,
	item: Item,
	transport: BatchTransport,
	state: Extract<BatchState, { state: 'ended' }>
): Promise<boolean> {
	const result = await transport.result(item.providerBatchId ?? '', state, item.requestId);
	switch (result.kind) {
		case 'errored':
		case 'expired':
		case 'canceled':
			return ctx.runMutation(internal.aiRouting.batchItems.failItem, {
				itemId: item._id,
				outcome: result.kind,
			});
		case 'missing':
			return ctx.runMutation(internal.aiRouting.batchItems.abandonItem, { itemId: item._id });
		case 'succeeded':
			break;
	}
	const route: BatchRoute = { provider: item.provider, apiKey: 'replay', modelId: item.modelId };
	const call = batchCallOf(item.consumer);
	const replayed = await replayObjectResult(route, call, result.body);
	const request = toMeteredRequest(replayed.request);
	const base = { itemId: item._id, ...(request ? { request } : {}) };
	if (replayed.outcome !== 'succeeded') {
		return ctx.runMutation(internal.aiRouting.batchItems.completeItem, {
			...base,
			outcome: replayed.outcome,
		});
	}
	const output = call.output(replayed.object);
	if (output.kind === 'summary') {
		return ctx.runMutation(internal.aiRouting.batchItems.completeItem, {
			...base,
			outcome: 'succeeded',
			summary: output.summary,
		});
	}
	// The same per-message cap the real-time extraction applies (L7).
	const entries =
		item.consumer === 'knowledge_file' || output.entries.length === 0
			? output.entries
			: await capPerMessage(ctx, output.entries);
	return ctx.runMutation(internal.aiRouting.batchItems.completeItem, {
		...base,
		outcome: 'succeeded',
		entries,
	});
}

async function pollItem(
	ctx: ActionCtx,
	item: Item,
	transports: Map<string, BatchTransport>
): Promise<void> {
	// Never confirmed within its grace, or no result by its expiry.
	if (item.status === 'submitting' || !item.providerBatchId || Date.now() > item.expiresAt) {
		await ctx.runMutation(internal.aiRouting.batchItems.abandonItem, { itemId: item._id });
		return;
	}
	const transport = transports.get(item.provider);
	if (!transport) {
		// The plane moved off this provider: its key cannot read the batch now.
		await ctx.runMutation(internal.aiRouting.batchItems.postponePoll, { itemId: item._id });
		return;
	}
	const state = await transport.state(item.providerBatchId);
	if (state.state === 'running') {
		await ctx.runMutation(internal.aiRouting.batchItems.postponePoll, { itemId: item._id });
		return;
	}
	if (await closeEnded(ctx, item, transport, state)) {
		await transport.cleanup(state, item.providerFileId);
	}
}

export const poll = internalAction({
	args: { page: v.optional(v.number()) },
	handler: async (ctx, args) => {
		anchorActionDeadline(ctx);
		const due = await ctx.runQuery(internal.aiRouting.batchItems.duePolls, { limit: PAGE });
		if (due.length === 0) return;
		const transports = await transportsByProvider(ctx);
		for (const item of due) {
			try {
				await pollItem(ctx, item, transports);
			} catch (error) {
				// One item's failure never stops the page; it is asked again later.
				logWarn('[batch] poll failed', { itemId: item._id, error: secretFreeErrorText(error) });
				await ctx.runMutation(internal.aiRouting.batchItems.postponePoll, { itemId: item._id });
			}
		}
		const page = args.page ?? 1;
		if (due.length === PAGE && page < MAX_PAGES) {
			await ctx.scheduler.runAfter(0, internal.aiRouting.batchPoller.poll, { page: page + 1 });
		}
	},
});
