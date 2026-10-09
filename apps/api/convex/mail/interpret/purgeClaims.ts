/**
 * One claim (item or fact) under a message purge (review round 3, rule P):
 *
 *  - the evidence entries that name a purged source go;
 *  - a claim left without evidence is `doomed`: the caller clears its links
 *    (`purgeLinks.ts`) and deletes it;
 *  - a claim that survives on other evidence is REDACTED, safe by
 *    construction: every extracted value a person did not confirm goes. Its
 *    text becomes the neutral line ("Details removed with the deleted
 *    message"), its parties unclear (no address, no name), its
 *    responsibility `unclear`, its deadline, amount and options cleared, its
 *    facets and consequences kept only when a surviving source's claim record
 *    still names the item. A fact loses its text and value the same way. The
 *    redacted fields are listed in `redactedFields`, review is flagged, and
 *    the thread is re-read from its surviving sources (`purge.ts`
 *    `reinterpretRange`): a verified claim then refills the fields directly
 *    (`reducePlan.ts` / `reducePlanFacts.ts` read the marker);
 *  - what a person confirmed (correction `confirmed`) stays, as do the
 *    status, assignee and reminder a person set;
 *  - an unconfirmed held update (`pendingUpdate`) a purged source supported
 *    goes whole, and so does a confirmation undo snapshot (`confirmedFrom`)
 *    that moved a purged source's evidence: neither can bring a purged value
 *    back;
 *  - a status or disposition the purged source set, as a message or as a
 *    recorded operation on it (`op:<sourceKey>`), goes back to `open` /
 *    `unanswered` (`transitionSources.ts resetTransitionsFrom`).
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { writeItemChange } from './counters';
import type { DrainBudget } from './purgeDrain';
import { resetTransitionsFrom } from './transitionSources';

/** The neutral line a redacted claim shows. */
export const REDACTED_CLAIM_TEXT = {
	en: 'Details removed with the deleted message',
	de: 'Details mit der gelöschten Nachricht entfernt',
} as const;

/** What an item's redaction clears (`threadItems.redactedFields`). */
export const REDACTED_ITEM_FIELDS = [
	'assertion',
	'display',
	'requester',
	'responsible',
	'beneficiary',
	'responsibility',
	'due',
	'amount',
	'options',
] as const;
/** What a fact's redaction clears (`threadFacts.redactedFields`). */
export const REDACTED_FACT_FIELDS = ['assertion', 'display', 'value'] as const;

export type ClaimFate = 'untouched' | 'doomed' | 'survived';

/** An item patch as the counters' item write takes it. */
type ItemPatch = Parameters<typeof writeItemChange>[3];

/** The purged sources, by id (evidence) and by key (lineage, extractions). */
export interface PurgedSources {
	ids: ReadonlySet<string>;
	keys: ReadonlySet<string>;
}

/** The source key a lineage or claim key starts with (`<sourceKey>#…`). Pure. */
export function lineageSource(lineage: string): string {
	const at = lineage.indexOf('#');
	return at < 0 ? lineage : lineage.slice(0, at);
}

/**
 * The patch that reverts what the purged sources set on an item: its status
 * back to `open`, its disposition back to `unanswered`, review flagged
 * (`transitionSources.ts`, which also matches the `op:<sourceKey>` a
 * recorded operation on the source wrote); what a person or another source
 * set stays. Pure.
 */
export function transitionReset(item: Doc<'threadItems'>, purged: PurgedSources): ItemPatch | null {
	let current: Doc<'threadItems'> = item;
	let patch: ItemPatch | null = null;
	for (const key of purged.keys) {
		const reset = resetTransitionsFrom(current, key);
		if (!reset) continue;
		patch = { ...patch, ...reset } as ItemPatch;
		current = { ...current, ...reset } as Doc<'threadItems'>;
	}
	return patch;
}

/** Does an undo snapshot hold evidence a purged source moved onto the item? Pure. */
export function isSnapshotPurged(
	snapshot: Doc<'threadItems'>['confirmedFrom'],
	purged: PurgedSources
): boolean {
	return !!snapshot?.addedEvidenceKeys.some((key) =>
		purged.keys.has(key.slice(0, key.indexOf('|')))
	);
}

async function sealedPair(text: { en: string; de: string }) {
	return { en: await sealBodyAtWrite(text.en), de: await sealBodyAtWrite(text.de) };
}

/**
 * Does a surviving source's claim record (`interpretSources.claimIds`) still
 * name the row? Read per source its surviving evidence names (a handful).
 */
async function isNamedBySurvivingRecord(
	ctx: MutationCtx,
	rowId: Id<'threadItems'>,
	evidence: Doc<'threadItems'>['evidence'],
	budget: DrainBudget
): Promise<boolean> {
	for (const sourceKey of new Set(evidence.map((e) => interpretationSourceKey(e.source)))) {
		budget.range();
		const record = await ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', sourceKey))
			.first();
		budget.charge(record);
		if (record?.claimIds?.some((entry) => entry.itemId === rowId)) return true;
	}
	return false;
}

/** The redaction of an item's unconfirmed extracted values (rule P). */
async function redactedItem(isFacetsKept: boolean): Promise<ItemPatch> {
	const unclear = { isUs: false };
	return {
		assertion: await sealBodyAtWrite(REDACTED_CLAIM_TEXT.en),
		display: await sealedPair(REDACTED_CLAIM_TEXT),
		requester: unclear,
		responsible: unclear,
		beneficiary: undefined,
		responsibility: 'unclear',
		due: undefined,
		amount: undefined,
		options: undefined,
		counterpartyKey: undefined,
		...(isFacetsKept ? {} : { facets: [], consequences: undefined }),
		redactedFields: [
			...REDACTED_ITEM_FIELDS,
			...(isFacetsKept ? [] : ['facets', 'consequences']),
		],
	};
}

/** Strip one item; a survivor is redacted and written through the counters' item write. */
export async function stripItem(
	ctx: MutationCtx,
	ref: ThreadRef,
	item: Doc<'threadItems'>,
	purged: PurgedSources,
	budget: DrainBudget
): Promise<ClaimFate> {
	const names = (evidence: ReadonlyArray<{ source: { id: string } }>) =>
		evidence.some((e) => purged.ids.has(e.source.id));
	const isPendingNamed = !!item.pendingUpdate && names(item.pendingUpdate.evidence);
	const reset = transitionReset(item, purged);
	const stamp = { revision: item.revision + 1, updatedAt: Date.now() };
	if (!names(item.evidence) && !isPendingNamed) {
		// No evidence of the purged source, but a status or disposition it set
		// (a bounced send's `failed` names the send, not the item's evidence).
		if (!reset) return 'untouched';
		await writeItemChange(ctx, ref, item, { ...reset, ...stamp });
		return 'survived';
	}
	const evidence = item.evidence.filter((e) => !purged.ids.has(e.source.id));
	if (evidence.length === 0) return 'doomed';

	const isEvidenceLost = evidence.length !== item.evidence.length;
	const isConfirmed = item.correction?.kind === 'confirmed';
	const patch: ItemPatch = {
		evidence,
		...(isEvidenceLost && !isConfirmed
			? await redactedItem(await isNamedBySurvivingRecord(ctx, item._id, evidence, budget))
			: {}),
		...(isPendingNamed ? { pendingUpdate: undefined } : {}),
		...(isSnapshotPurged(item.confirmedFrom, purged) ? { confirmedFrom: undefined } : {}),
		...(item.lineageKeys
			? { lineageKeys: item.lineageKeys.filter((k) => !purged.keys.has(lineageSource(k))) }
			: {}),
		...(item.lineage && purged.keys.has(lineageSource(item.lineage)) ? { lineage: undefined } : {}),
		...reset,
		isReviewNeeded: true,
		...stamp,
	};
	await writeItemChange(ctx, ref, item, patch);
	return 'survived';
}

/** Strip one fact (mail threads only); a survivor is redacted. */
export async function stripFact(
	ctx: MutationCtx,
	fact: Doc<'threadFacts'>,
	purged: PurgedSources
): Promise<ClaimFate> {
	if (!fact.evidence.some((e) => purged.ids.has(e.source.id))) return 'untouched';
	const evidence = fact.evidence.filter((e) => !purged.ids.has(e.source.id));
	if (evidence.length === 0) return 'doomed';
	await ctx.db.patch(fact._id, {
		evidence,
		assertion: await sealBodyAtWrite(REDACTED_CLAIM_TEXT.en),
		display: await sealedPair(REDACTED_CLAIM_TEXT),
		value: undefined,
		redactedFields: [...REDACTED_FACT_FIELDS],
		...(fact.lineage && purged.keys.has(lineageSource(fact.lineage)) ? { lineage: undefined } : {}),
		revision: fact.revision + 1,
		updatedAt: Date.now(),
	});
	return 'survived';
}
