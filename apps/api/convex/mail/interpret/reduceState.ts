/**
 * The reducer's reads and small pure helpers (`reduce.ts` applyInterpretation):
 * whether the source still sits in the thread, the plan state (items and
 * current facts, unsealed for matching), the thread's extractions and the
 * completeness they add up to, and the "Latest update" line the list-row
 * projection (`briefTop.ts`) stores.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { BriefCompleteness, InterpretMode } from '@owlat/shared/threadBrief';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody } from '../../lib/messageBody';
import { loadPromptItemCandidates, threadItemsWithStatus } from './load';
import type { PlanFact, PlanItem } from './reducePlan';
import type { ReduceResult } from './reduceInput';

/** Interpretations scanned per thread when completeness is recomputed. */
const COMPLETENESS_SCAN = 200;
/** Current facts read into the plan. */
const FACT_SCAN = 200;

/** Does the source still exist, in this thread? */
export async function sourceStillInThread(
	ctx: MutationCtx,
	source: InterpretationSource,
	ref: ThreadRef
): Promise<boolean> {
	switch (source.kind) {
		case 'mail':
		case 'outboundMail': {
			const message = await ctx.db.get(source.id);
			return !!message && ref.kind === 'mail' && message.threadId === ref.id;
		}
		case 'inbound': {
			const inbound = await ctx.db.get(source.id);
			return !!inbound && ref.kind === 'team' && inbound.threadId === ref.id;
		}
		case 'teamReply': {
			const reply = await ctx.db.get(source.id);
			const inbound = reply?.inboundMessageId ? await ctx.db.get(reply.inboundMessageId) : null;
			return !!inbound && ref.kind === 'team' && inbound.threadId === ref.id;
		}
	}
}

/**
 * Completeness of the thread from its extractions: partial while the newest
 * extraction of any source failed, came back partial, or could not be read.
 */
export function completenessOf(
	rows: ReadonlyArray<
		Pick<Doc<'messageInterpretations'>, 'sourceKey' | 'status' | 'skipReason' | 'updatedAt'>
	>
): BriefCompleteness {
	const newest = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const seen = newest.get(row.sourceKey);
		if (!seen || row.updatedAt > seen.updatedAt) newest.set(row.sourceKey, row);
	}
	if (newest.size === 0) return 'none';
	for (const row of newest.values()) {
		if (row.status === 'failed' || row.status === 'partial') return 'partial';
		if (row.status === 'skipped' && row.skipReason === 'undecryptable') return 'partial';
	}
	return 'complete';
}

export async function threadInterpretations(ctx: MutationCtx, ref: ThreadRef) {
	return ref.kind === 'mail'
		? ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
				.order('desc')
				.take(COMPLETENESS_SCAN)
		: ctx.db
				.query('messageInterpretations')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
				.order('desc')
				.take(COMPLETENESS_SCAN);
}

export async function loadPlanState(ctx: MutationCtx, ref: ThreadRef, mode: 'brief' | 'actions') {
	const { rows } = await loadPromptItemCandidates(ctx, ref);
	// Every open item takes part in matching, not only the prompt page.
	const open = await threadItemsWithStatus(ctx, ref, 'open', 500);
	const byId = new Map<string, Doc<'threadItems'>>();
	for (const row of [...rows, ...open]) byId.set(row._id, row);
	const items: PlanItem[] = await Promise.all(
		[...byId.values()].map(async (row) => ({
			...row,
			assertionText: await openMessageBody(row.assertion),
		}))
	);
	let facts: PlanFact[] = [];
	if (mode === 'brief' && ref.kind === 'mail') {
		const rowsF = await ctx.db
			.query('threadFacts')
			.withIndex('by_mail_thread_and_status', (q) =>
				q.eq('mailThreadId', ref.id).eq('status', 'current')
			)
			.take(FACT_SCAN);
		facts = await Promise.all(
			rowsF.map(async (row) => ({
				...row,
				...(row.value && 'text' in row.value
					? { valueText: await openMessageBody(row.value.text) }
					: {}),
			}))
		);
	}
	return { items, facts };
}

/**
 * What the list-row projection's "Latest update" becomes after this message
 * (`refreshBriefTop`'s `latest`): its first line per locale; null clears it
 * (actions mode, short or security mail, a message with nothing new);
 * undefined keeps the stored one (no result, or an older message arriving
 * late). Pure.
 */
export function briefTopLatestOf(
	result: Pick<ReduceResult, 'latest' | 'latestSuppressed'> | undefined,
	opts: { mode: InterpretMode; isOutOfOrder: boolean }
): { en: string; de: string } | null | undefined {
	if (!result || opts.isOutOfOrder) return undefined;
	if (opts.mode === 'actions' || result.latestSuppressed) return null;
	const en = result.latest?.en[0]?.text;
	const de = result.latest?.de[0]?.text;
	if (!en && !de) return null;
	return { en: en ?? de ?? '', de: de ?? en ?? '' };
}
