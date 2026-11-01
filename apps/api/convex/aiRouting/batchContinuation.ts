/**
 * Where a provider batch item's work goes once it is over,
 * split out of `./batchItems.ts`, whose terminal mutations call these in the
 * same transaction: a usable result continues through the paths that already
 * exist (the extraction's `in_progress` marker, file processing re-run with
 * the summary), and anything else hands the source back to the real-time path
 * once. A source deleted meanwhile is left alone.
 */

import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { BatchConsumer } from '../lib/validators/aiRouting';
import type { BatchedFileSummary } from '../analytics/backgroundDeferral';
import { isFeatureEnabled } from '../lib/featureFlags';
import { guardStanding } from '../agent/steps/security_scan/disposition';
import { isInKnowledgeFolder } from '../mail/liveKnowledge';
import {
	readExtractionProgress,
	writeExtractionMarker,
	type ExtractionSourceType,
} from '../knowledge/extractionProgress';

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
			await ctx.scheduler.runAfter(0, internal.files.processing.processFile, {
				fileId: source.id,
				...(summary ? { batchedSummary: summary } : {}),
			});
			return;
	}
}

/** Nothing usable came back: the source goes to the real-time path, once. */
export async function handBack(ctx: MutationCtx, item: Doc<'llmBatchItems'>): Promise<void> {
	await rerun(ctx, item);
}

/**
 * The guards the live extraction path runs, rechecked now that the result is
 * back (Sol r2 F1): the batch was out for up to a day. `ai.knowledge` still
 * on; a Team message the scan or a late guard has since held back
 * (quarantine, malware, phishing, a quarantine-confidence injection) is not
 * read; Postbox mail moved to Spam, Trash, Sent or Drafts is not read. Checked
 * in the transaction that would keep the result, so a refusal keeps nothing:
 * the result is dropped, the item already settled. The resumed extraction
 * runs its own guards again (`knowledge/extraction.ts`,
 * `knowledge/batchedMail.ts`).
 */
async function mayKeepExtraction(
	ctx: MutationCtx,
	source: NonNullable<Awaited<ReturnType<typeof liveSourceId>>>
): Promise<boolean> {
	if (!(await isFeatureEnabled(ctx, 'ai.knowledge'))) return false;
	switch (source.consumer) {
		case 'knowledge_message': {
			const message = await ctx.db.get(source.id);
			return message !== null && guardStanding(message) !== 'rejected';
		}
		case 'knowledge_mail':
			return isInKnowledgeFolder(ctx, source.id);
		default:
			return true;
	}
}

/** A usable result: continue the source's work with it. */
export async function continueWith(
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
	const source = await liveSourceId(ctx, item);
	if (!source || !(await mayKeepExtraction(ctx, source))) return;
	const sourceType = EXTRACTION_SOURCE[item.consumer];
	const progress = await readExtractionProgress(ctx, sourceType, item.sourceId);
	// Another run got there first (a real-time run while this was out): keep its.
	if (progress.isDone || progress.isPartial) return;
	// The marker a resumed extraction saves without asking the model again.
	await writeExtractionMarker(ctx, sourceType, item.sourceId, 'in_progress', entries);
	await rerun(ctx, item);
}
