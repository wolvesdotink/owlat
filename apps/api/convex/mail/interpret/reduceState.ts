/**
 * The reducer's reads (`reduce.ts` applyInterpretation): whether the source
 * still sits in the thread, the thread's items and current facts as
 * in-memory state (`fold.ts`), and the "Latest update" line the list-row
 * projection (`briefTop.ts`) stores.
 *
 * The fold sees every item of the thread up to {@link FOLD_MAX_ITEMS}; the
 * rows the model or a source's claim record names are loaded by id on top
 * (`reduceIdentity.ts`), so identity never depends on the scan reaching them.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { ITEM_STATUSES, type InterpretMode } from '@owlat/shared/threadBrief';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody } from '../../lib/messageBody';
import { exactValueKey } from './factEquivalence';
import { rowFactKeyHash } from './factKeys';
import { threadItemsWithStatus } from './load';
import { teamReplyContext } from './sources';
import type { MemFact, MemItem, MemState } from './fold';
import type { ReduceResult } from './reduceInput';

/** Current facts read into the state. */
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
			const reply = await teamReplyContext(ctx, source.id);
			return !!reply && ref.kind === 'team' && reply.threadId === ref.id;
		}
	}
}

/** A row's assertion and display, opened: the current text and the stored one to compare with. */
async function openedText(row: Pick<Doc<'threadItems'>, 'assertion' | 'display'>) {
	const assertionText = await openMessageBody(row.assertion);
	return {
		assertionText,
		storedAssertionText: assertionText,
		storedDisplay: {
			en: await openMessageBody(row.display.en),
			de: await openMessageBody(row.display.de),
		},
	};
}

/** A stored held update in memory: its wording opened, and kept to compare against. */
async function heldToMem(
	held: Doc<'threadItems'>['pendingUpdate']
): Promise<Pick<MemItem, 'pendingUpdate' | 'storedPending'>> {
	if (!held) return {};
	const text = {
		...(held.assertion !== undefined ? { assertion: await openMessageBody(held.assertion) } : {}),
		...(held.display
			? {
					display: {
						en: await openMessageBody(held.display.en),
						de: await openMessageBody(held.display.de),
					},
				}
			: {}),
	};
	return {
		pendingUpdate: { ...held, ...text, evidence: [...held.evidence] },
		storedPending: text,
	};
}

export async function itemToMem(row: Doc<'threadItems'>): Promise<MemItem> {
	return {
		_id: row._id,
		...(row.lineage ? { lineage: row.lineage } : {}),
		...(row.lineageKeys ? { lineageKeys: [...row.lineageKeys] } : {}),
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
		...(row.lastTransitionAt !== undefined ? { lastTransitionAt: row.lastTransitionAt } : {}),
		...(row.statusSource ? { statusSource: row.statusSource } : {}),
		...(row.dispositionSource ? { dispositionSource: row.dispositionSource } : {}),
		...(row.redactedFields ? { redactedFields: row.redactedFields } : {}),
		...(row.fieldSources ? { fieldSources: { ...row.fieldSources } } : {}),
		...(await openedText(row)),
		...(await heldToMem(row.pendingUpdate)),
		requester: row.requester,
		responsible: row.responsible,
		...(row.beneficiary ? { beneficiary: row.beneficiary } : {}),
		responsibility: row.responsibility,
		askedAt: row.askedAt,
		...(row.possibleDuplicateOfId ? { possibleDuplicateOfId: row.possibleDuplicateOfId } : {}),
	};
}

export async function factToMem(row: Doc<'threadFacts'>): Promise<MemFact> {
	const opened =
		row.value && 'text' in row.value
			? { ...row.value, text: await openMessageBody(row.value.text) }
			: row.value;
	return {
		_id: row._id,
		...(exactValueKey(opened) !== undefined ? { storedValueKey: exactValueKey(opened) } : {}),
		...(row.lineage ? { lineage: row.lineage } : {}),
		...(row.redactedFields ? { redactedFields: row.redactedFields } : {}),
		isNew: false,
		factKeyHash: await rowFactKeyHash(row),
		status: row.status,
		revision: row.revision,
		...(row.value ? { value: row.value } : {}),
		...(row.value && 'text' in row.value
			? { valueText: await openMessageBody(row.value.text) }
			: {}),
		...(await openedText(row)),
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

/** Items read into a fold, across every status. */
export const FOLD_MAX_ITEMS = 500;

/**
 * The rows a fold starts from: every item of the thread (all statuses, up to
 * {@link FOLD_MAX_ITEMS}) and the current facts. Past the bound the open
 * items come first, so a match to an open item always resolves.
 */
export async function loadFoldState(
	ctx: MutationCtx,
	ref: ThreadRef,
	mode: InterpretMode
): Promise<{
	state: MemState;
	rows: Map<string, Doc<'threadItems'>>;
	factRows: Map<string, Doc<'threadFacts'>>;
	/** The thread holds more items than the scan read. */
	isItemScanCut: boolean;
	/** The thread holds more current facts than the scan read. */
	isFactScanCut: boolean;
}> {
	const rows = new Map<string, Doc<'threadItems'>>();
	let isItemScanCut = false;
	for (const status of ITEM_STATUSES) {
		const left = FOLD_MAX_ITEMS - rows.size;
		const page = await threadItemsWithStatus(ctx, ref, status, left + 1);
		if (page.length > left) isItemScanCut = true;
		for (const row of page.slice(0, left)) rows.set(row._id, row);
		if (isItemScanCut) break;
	}
	const factRows = new Map<string, Doc<'threadFacts'>>();
	let isFactScanCut = false;
	if (mode === 'brief') {
		const page = await currentFacts(ctx, ref, FACT_SCAN + 1);
		isFactScanCut = page.length > FACT_SCAN;
		for (const row of page.slice(0, FACT_SCAN)) factRows.set(row._id, row);
	}
	const state: MemState = { items: new Map(), facts: new Map() };
	for (const row of rows.values()) state.items.set(row._id, await itemToMem(row));
	for (const row of factRows.values()) state.facts.set(row._id, await factToMem(row));
	return { state, rows, factRows, isItemScanCut, isFactScanCut };
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
