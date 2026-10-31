'use node';

/**
 * The provider batch poller: asks each submitted batch item's
 * provider whether its batch has ended and, when it has, reads the item's
 * result line and closes the item through `./batchItems.ts` `settleItem`,
 * which writes the ledger row and settles the hold in one mutation. A cron
 * runs it; it takes one page of due items at a time and continues while more
 * are due, a bounded number of pages per run, so a backlog drains at a
 * bounded rate.
 *
 * Runs whatever the switch says: an item submitted while `batchApi` was
 * `enforce` is still owed its result after the switch goes back off.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { Settlement } from './batchItems';
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

const POSTPONE: Settlement = { kind: 'postpone' };

/** Read an ended batch's line for the item: how the item settles. */
async function endedSettlement(
	ctx: ActionCtx,
	item: Item,
	transport: BatchTransport,
	state: Extract<BatchState, { state: 'ended' }>
): Promise<Settlement> {
	const result = await transport.result(item.providerBatchId ?? '', state, item.requestId);
	switch (result.kind) {
		case 'errored':
		case 'expired':
		case 'canceled':
			return { kind: 'fail', outcome: result.kind };
		case 'missing':
			return { kind: 'abandon' };
		case 'succeeded':
			break;
	}
	const route: BatchRoute = { provider: item.provider, apiKey: 'replay', modelId: item.modelId };
	const call = batchCallOf(item.consumer);
	const replayed = await replayObjectResult(route, call, result.body);
	const request = toMeteredRequest(replayed.request);
	const base = { kind: 'complete' as const, ...(request ? { request } : {}) };
	if (replayed.outcome !== 'succeeded') return { ...base, outcome: replayed.outcome };
	const output = call.output(replayed.object);
	if (output.kind === 'summary') return { ...base, outcome: 'succeeded', summary: output.summary };
	// The same per-message cap the real-time extraction applies (L7).
	const entries =
		item.consumer === 'knowledge_file' || output.entries.length === 0
			? output.entries
			: await capPerMessage(ctx, output.entries);
	return { ...base, outcome: 'succeeded', entries };
}

/** How one due item settles, and the provider cleanup owed once it has. */
async function pollItem(
	ctx: ActionCtx,
	item: Item,
	transports: Map<string, BatchTransport>
): Promise<{ settlement: Settlement; cleanup?: () => Promise<void> }> {
	// Never confirmed within its grace, or no result by its expiry.
	if (item.status === 'submitting' || !item.providerBatchId || Date.now() > item.expiresAt) {
		return { settlement: { kind: 'abandon' } };
	}
	const transport = transports.get(item.provider);
	// The plane moved off this provider: its key cannot read the batch now.
	if (!transport) return { settlement: POSTPONE };
	const state = await transport.state(item.providerBatchId);
	if (state.state === 'running') return { settlement: POSTPONE };
	return {
		settlement: await endedSettlement(ctx, item, transport, state),
		cleanup: () => transport.cleanup(state, item.providerFileId),
	};
}

export const poll = internalAction({
	args: { page: v.optional(v.number()) },
	handler: async (ctx, args) => {
		anchorActionDeadline(ctx);
		const due = await ctx.runQuery(internal.aiRouting.batchItems.duePolls, { limit: PAGE });
		if (due.length === 0) return;
		const transports = await transportsByProvider(ctx);
		for (const item of due) {
			// One item's failure never stops the page; it is asked again later.
			let polled: Awaited<ReturnType<typeof pollItem>>;
			try {
				polled = await pollItem(ctx, item, transports);
			} catch (error) {
				logWarn('[batch] poll failed', { itemId: item._id, error: secretFreeErrorText(error) });
				polled = { settlement: POSTPONE };
			}
			let isClosed = false;
			try {
				// checkpoint: one item per transaction, so a failing item never rolls
				// back the others; settling closes only an item still open, and the
				// provider's files are deleted only once its close committed.
				isClosed = await ctx.runMutation(internal.aiRouting.batchItems.settleItem, {
					itemId: item._id,
					settlement: polled.settlement,
				});
			} catch (error) {
				// Still open: the next cron tick polls it again.
				logWarn('[batch] settle failed', { itemId: item._id, error: secretFreeErrorText(error) });
			}
			if (isClosed && polled.cleanup) {
				await polled.cleanup().catch((error: unknown) => {
					logWarn('[batch] cleanup failed', {
						itemId: item._id,
						error: secretFreeErrorText(error),
					});
				});
			}
		}
		const page = args.page ?? 1;
		if (due.length === PAGE && page < MAX_PAGES) {
			await ctx.scheduler.runAfter(0, internal.aiRouting.batchPoller.poll, { page: page + 1 });
		}
	},
});
