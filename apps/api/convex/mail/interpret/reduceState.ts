/**
 * The reducer's reads (`reduce.ts` applyInterpretation): whether the source
 * still sits in the thread, the thread's items and facts as in-memory state
 * (`replay.ts`), the stored extractions an ordered replay folds in, the
 * recorded and asserted item changes it re-applies, and the "Latest update"
 * line the list-row projection (`briefTop.ts`) stores.
 *
 * Every read is bounded; a replay over its budget says so (`isOverBudget`)
 * and the reducer falls back to the incremental rule, marking the run partial.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { ITEM_STATUSES, type InterpretMode } from '@owlat/shared/threadBrief';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody } from '../../lib/messageBody';
import { loadPromptItemCandidates, readResult, threadItemsWithStatus } from './load';
import type { HumanOp, LineageSeed, MemFact, MemItem, MemState, ReplayEntry } from './replay';
import type { ReduceResult } from './reduceInput';

/** Open items read into an incremental fold (matching sees all of them, up to this). */
const OPEN_SCAN = 500;
/** Current facts read into the state. */
const FACT_SCAN = 200;
/** Replay budget: extractions folded, items and facts rebuilt, activity rows re-applied. */
export const REPLAY_MAX_SOURCES = 60;
export const REPLAY_MAX_ROWS = 400;
const REPLAY_INTERPRETATION_SCAN = 300;
const REPLAY_ACTIVITY_SCAN = 1000;

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

export async function itemToMem(row: Doc<'threadItems'>): Promise<MemItem> {
	return {
		_id: row._id,
		...(row.lineage ? { lineage: row.lineage } : {}),
		isNew: false,
		status: row.status,
		disposition: row.disposition,
		intent: row.intent,
		revision: row.revision,
		evidence: [...row.evidence],
		...(row.correction ? { correction: row.correction } : {}),
		verify: row.verify,
		...(row.due ? { due: row.due } : {}),
		...(row.amount ? { amount: row.amount } : {}),
		...(row.options ? { options: row.options } : {}),
		...(row.completion ? { completion: row.completion } : {}),
		...(row.isReviewNeeded !== undefined ? { isReviewNeeded: row.isReviewNeeded } : {}),
		assertionText: await openMessageBody(row.assertion),
		storedDisplay: {
			en: await openMessageBody(row.display.en),
			de: await openMessageBody(row.display.de),
		},
		...(row.pendingUpdate
			? { pendingUpdate: { ...row.pendingUpdate, evidence: [...row.pendingUpdate.evidence] } }
			: {}),
		askedAt: row.askedAt,
		...(row.possibleDuplicateOfId ? { possibleDuplicateOfId: row.possibleDuplicateOfId } : {}),
	};
}

export async function factToMem(row: Doc<'threadFacts'>): Promise<MemFact> {
	return {
		_id: row._id,
		...(row.lineage ? { lineage: row.lineage } : {}),
		isNew: false,
		factKey: row.factKey,
		status: row.status,
		revision: row.revision,
		...(row.value ? { value: row.value } : {}),
		...(row.value && 'text' in row.value
			? { valueText: await openMessageBody(row.value.text) }
			: {}),
		assertionText: await openMessageBody(row.assertion),
		evidence: [...row.evidence],
		...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
		...(row.conflictsWithId ? { conflictsWithId: row.conflictsWithId } : {}),
	};
}

async function currentFacts(ctx: MutationCtx, ref: ThreadRef, limit: number) {
	if (ref.kind !== 'mail') return [];
	return ctx.db
		.query('threadFacts')
		.withIndex('by_mail_thread_and_status', (q) =>
			q.eq('mailThreadId', ref.id).eq('status', 'current')
		)
		.take(limit);
}

/** The rows an incremental fold starts from (the prompt's view plus every open item). */
export async function loadIncrementalState(
	ctx: MutationCtx,
	ref: ThreadRef,
	mode: InterpretMode,
	now: number
): Promise<{
	state: MemState;
	rows: Map<string, Doc<'threadItems'>>;
	factRows: Map<string, Doc<'threadFacts'>>;
}> {
	const { rows: candidates } = await loadPromptItemCandidates(ctx, ref, now);
	const open = await threadItemsWithStatus(ctx, ref, 'open', OPEN_SCAN);
	const rows = new Map<string, Doc<'threadItems'>>();
	for (const row of [...candidates, ...open]) rows.set(row._id, row);
	const factRows = new Map<string, Doc<'threadFacts'>>();
	if (mode === 'brief')
		for (const row of await currentFacts(ctx, ref, FACT_SCAN)) factRows.set(row._id, row);
	const state: MemState = { items: new Map(), facts: new Map() };
	for (const row of rows.values()) state.items.set(row._id, await itemToMem(row));
	for (const row of factRows.values()) state.facts.set(row._id, await factToMem(row));
	return { state, rows, factRows };
}

/**
 * Everything a replay needs: every item and fact row of the thread (the base
 * state is the ones no extraction created), the lineage seed, the stored
 * extractions in any order, and the recorded/asserted item changes.
 */
export async function loadReplayState(
	ctx: MutationCtx,
	ref: ThreadRef,
	mode: InterpretMode
): Promise<
	| { isOverBudget: true }
	| {
			isOverBudget: false;
			base: MemState;
			seed: LineageSeed;
			rows: Map<string, Doc<'threadItems'>>;
			factRows: Map<string, Doc<'threadFacts'>>;
			entries: ReplayEntry[];
			ops: HumanOp[];
	  }
> {
	const rows = new Map<string, Doc<'threadItems'>>();
	for (const status of ITEM_STATUSES) {
		for (const row of await threadItemsWithStatus(ctx, ref, status, REPLAY_MAX_ROWS + 1)) {
			rows.set(row._id, row);
		}
	}
	if (rows.size > REPLAY_MAX_ROWS) return { isOverBudget: true };
	const factRows = new Map<string, Doc<'threadFacts'>>();
	if (mode === 'brief' && ref.kind === 'mail') {
		for (const status of ['current', 'superseded'] as const) {
			const found = await ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread_and_status', (q) =>
					q.eq('mailThreadId', ref.id).eq('status', status)
				)
				.take(REPLAY_MAX_ROWS + 1);
			for (const row of found) factRows.set(row._id, row);
		}
		if (factRows.size > REPLAY_MAX_ROWS) return { isOverBudget: true };
	}

	const interpretations =
		ref.kind === 'mail'
			? await ctx.db
					.query('messageInterpretations')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
					.take(REPLAY_INTERPRETATION_SCAN + 1)
			: await ctx.db
					.query('messageInterpretations')
					.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
					.take(REPLAY_INTERPRETATION_SCAN + 1);
	if (interpretations.length > REPLAY_INTERPRETATION_SCAN) return { isOverBudget: true };
	const current = interpretations.filter((r) => r.isCurrent && r.payload !== undefined);
	if (current.length > REPLAY_MAX_SOURCES) return { isOverBudget: true };
	const entries: ReplayEntry[] = [];
	for (const row of current) {
		const result = await readResult(row);
		if (!result) continue;
		entries.push({
			source: row.source,
			sourceKey: row.sourceKey,
			contentRevision: row.contentRevision,
			sourceAt: row.sourceAt ?? row.createdAt,
			appliedAt: row.appliedAt ?? row.updatedAt,
			result,
		});
	}

	const base: MemState = { items: new Map(), facts: new Map() };
	const seedItems = new Map<string, MemItem>();
	const seedFacts = new Map<string, MemFact>();
	for (const row of rows.values()) {
		const mem = await itemToMem(row);
		if (row.lineage) seedItems.set(row.lineage, mem);
		else base.items.set(row._id, mem);
	}
	for (const row of factRows.values()) {
		const mem = await factToMem(row);
		if (row.lineage) seedFacts.set(row.lineage, mem);
		else if (row.status === 'current') base.facts.set(row._id, mem);
	}

	const activity =
		ref.kind === 'mail'
			? await ctx.db
					.query('threadActivity')
					.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', ref.id))
					.take(REPLAY_ACTIVITY_SCAN + 1)
			: await ctx.db
					.query('threadActivity')
					.withIndex('by_conversation_thread_and_seq', (q) => q.eq('conversationThreadId', ref.id))
					.take(REPLAY_ACTIVITY_SCAN + 1);
	if (activity.length > REPLAY_ACTIVITY_SCAN) return { isOverBudget: true };
	const ops: HumanOp[] = activity
		.filter(
			(a) =>
				a.itemId !== undefined &&
				(a.provenance === 'recorded' || a.provenance === 'asserted') &&
				(a.delta?.statusTo !== undefined || a.delta?.dispositionTo !== undefined)
		)
		.map((a) => ({
			itemId: a.itemId as Id<'threadItems'>,
			...(a.delta?.statusTo ? { statusTo: a.delta.statusTo } : {}),
			...(a.delta?.dispositionTo ? { dispositionTo: a.delta.dispositionTo } : {}),
			...(a.delta?.completion ? { completion: a.delta.completion } : {}),
		}));

	return {
		isOverBudget: false,
		base,
		seed: { items: seedItems, facts: seedFacts },
		rows,
		factRows,
		entries,
		ops,
	};
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
