/**
 * One claim (item or fact) under a message purge (review round 1, F3):
 *
 *  - the evidence entries that name a purged source go (an unconfirmed
 *    `pendingUpdate` loses them too, and goes when none is left);
 *  - a claim left without evidence is `doomed`: the caller clears its links
 *    (`purgeLinks.ts`) and deletes it;
 *  - a claim that survives but whose WORDING came from a purged source (its
 *    lineage, or for an older row its first evidence) is restated from a
 *    surviving source's stored claim, matched by lineage (items: a claim key
 *    in `lineageKeys`; facts: the same fact key), or else redacted to a
 *    neutral line ("Details removed with the deleted message") with its
 *    extracted values (due, amount, options, fact value) dropped and review
 *    flagged;
 *  - a status or disposition the purged source set goes back to `open` /
 *    `unanswered` with review flagged (`transitionSources.ts
 *    resetTransitionsFrom`); what a person or another source set stays.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody, sealBodyAtWrite } from '../../lib/messageBody';
import { writeItemChange } from './counters';
import type { DrainBudget } from './purgeDrain';
import type { ReduceFact, ReduceItem, ReduceResult } from './reduceInput';
import { factLineage, itemLineage } from './fold';
import { resetTransitionsFrom } from './transitionSources';
import { isHolding, revertPurgedConfirmation, withoutSources } from './heldSources';

/** The neutral line a claim whose wording came from a purged message shows. */
export const REDACTED_CLAIM_TEXT = {
	en: 'Details removed with the deleted message',
	de: 'Details mit der gelöschten Nachricht entfernt',
} as const;

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
 * Did the claim's wording come from a purged source? Its origin is the claim
 * key that first produced it (`lineage`, else the first of `lineageKeys`);
 * an older row without either falls back to its first evidence. Pure.
 */
export function isWordingPurged(
	row: {
		lineage?: string;
		lineageKeys?: readonly string[];
		evidence: ReadonlyArray<{ source: { id: string } }>;
	},
	purged: PurgedSources
): boolean {
	const origin = row.lineage ?? row.lineageKeys?.[0];
	if (origin) return purged.keys.has(lineageSource(origin));
	const first = row.evidence[0];
	return !!first && purged.ids.has(first.source.id);
}

/**
 * The patch that reverts what the purged sources set on an item: its status
 * back to `open`, its disposition back to `unanswered`, review flagged
 * (`transitionSources.ts`); what a person or another source set stays. Pure.
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

/** Strip one item; a survivor's patch goes through the counters' item write. */
export async function stripItem(
	ctx: MutationCtx,
	ref: ThreadRef,
	item: Doc<'threadItems'>,
	purged: PurgedSources,
	budget: DrainBudget
): Promise<ClaimFate> {
	const names = (evidence: ReadonlyArray<{ source: { id: string } }>) =>
		evidence.some((e) => purged.ids.has(e.source.id));
	const pending = item.pendingUpdate;
	// A held field or transition names its source even without quotes (round 7 F1).
	const isPendingNamed =
		!!pending &&
		(names(pending.evidence) ||
			(pending.fieldSources ?? []).some((f) => purged.keys.has(f.sourceKey)) ||
			(pending.transitions ?? []).some((t) => purged.keys.has(t.sourceKey)));
	const reverted = revertPurgedConfirmation(item, purged.keys);
	if (!names(item.evidence) && !isPendingNamed && !reverted) return 'untouched';
	const evidence = item.evidence.filter((e) => !purged.ids.has(e.source.id));
	if (evidence.length === 0) return 'doomed';

	const pendingEvidence = pending?.evidence.filter((e) => !purged.ids.has(e.source.id)) ?? [];
	const patch: ItemPatch = {
		evidence,
		...(isPendingNamed ? { pendingUpdate: strippedHeld(pending!, pendingEvidence, purged) } : {}),
		...reverted?.patch,
		...(item.lineageKeys
			? { lineageKeys: item.lineageKeys.filter((k) => !purged.keys.has(lineageSource(k))) }
			: {}),
		...transitionReset(item, purged),
		revision: item.revision + 1,
		updatedAt: Date.now(),
	};
	const isRedacted = isWordingPurged(item, purged);
	if (isRedacted) {
		Object.assign(patch, (await restatedItem(ctx, item, purged, budget)) ?? (await redactedItem()));
	}
	const confirmedFrom = strippedConfirmation(
		reverted?.confirmedFrom ?? item.confirmedFrom,
		purged,
		isRedacted
	);
	if (confirmedFrom !== item.confirmedFrom) patch.confirmedFrom = confirmedFrom;
	await writeItemChange(ctx, ref, item, patch);
	return 'survived';
}

/**
 * A held update that named a purged source: its surviving quotes, without
 * every field, removal and transition the purged sources proposed
 * (`heldSources.ts`); gone when nothing is left. Pure.
 */
function strippedHeld(
	held: NonNullable<Doc<'threadItems'>['pendingUpdate']>,
	evidence: NonNullable<Doc<'threadItems'>['pendingUpdate']>['evidence'],
	purged: PurgedSources
): Doc<'threadItems'>['pendingUpdate'] {
	const kept = withoutSources(held, purged.keys);
	// Without per-field sources (a held update written before them) the values
	// stand on the quotes alone: no quotes left, nothing held.
	const isStanding = held.fieldSources ? isHolding(kept) : (kept.transitions?.length ?? 0) > 0;
	return evidence.length > 0 || isStanding ? { ...kept, evidence } : undefined;
}

/**
 * A confirmation's undo snapshot without the evidence keys of a purged
 * source; gone with an item whose wording came from one (its saved values
 * could restore what the purged message said). Pure.
 */
export function strippedConfirmation(
	snapshot: Doc<'threadItems'>['confirmedFrom'],
	purged: PurgedSources,
	isRedacted: boolean
): Doc<'threadItems'>['confirmedFrom'] {
	if (!snapshot) return snapshot;
	if (isRedacted) return undefined;
	const keys = snapshot.addedEvidenceKeys.filter(
		(key) => !purged.keys.has(key.slice(0, key.indexOf('|')))
	);
	return keys.length === snapshot.addedEvidenceKeys.length
		? snapshot
		: { ...snapshot, addedEvidenceKeys: keys };
}

/** Strip one fact (mail threads only). */
export async function stripFact(
	ctx: MutationCtx,
	fact: Doc<'threadFacts'>,
	purged: PurgedSources,
	budget: DrainBudget
): Promise<ClaimFate> {
	if (!fact.evidence.some((e) => purged.ids.has(e.source.id))) return 'untouched';
	const evidence = fact.evidence.filter((e) => !purged.ids.has(e.source.id));
	if (evidence.length === 0) return 'doomed';
	const patch: Partial<Doc<'threadFacts'>> = {
		evidence,
		revision: fact.revision + 1,
		updatedAt: Date.now(),
	};
	if (isWordingPurged(fact, purged)) {
		const sources = [...new Set(evidence.map((e) => `${e.source.kind}:${e.source.id}`))];
		Object.assign(
			patch,
			(await restatedFact(ctx, fact, sources, budget)) ?? (await redactedFact())
		);
	}
	await ctx.db.patch(fact._id, patch);
	return 'survived';
}

/** The stored result of a source's current extraction, or null. */
async function currentResult(
	ctx: MutationCtx,
	sourceKey: string,
	budget: DrainBudget
): Promise<ReduceResult | null> {
	budget.range();
	const row = await ctx.db
		.query('messageInterpretations')
		.withIndex('by_source_current', (q) => q.eq('sourceKey', sourceKey).eq('isCurrent', true))
		.first();
	budget.read(row);
	if (!row?.payload) return null;
	try {
		return JSON.parse(await openMessageBody(row.payload)) as ReduceResult;
	} catch {
		return null;
	}
}

async function sealedPair(text: { en: string; de: string }) {
	return { en: await sealBodyAtWrite(text.en), de: await sealBodyAtWrite(text.de) };
}

/** The item's wording from a surviving source's claim of it (by claim key), or null. */
async function restatedItem(
	ctx: MutationCtx,
	item: Doc<'threadItems'>,
	purged: PurgedSources,
	budget: DrainBudget
): Promise<ItemPatch | null> {
	for (const key of item.lineageKeys ?? []) {
		const sourceKey = lineageSource(key);
		if (purged.keys.has(sourceKey)) continue;
		const result = await currentResult(ctx, sourceKey, budget);
		const base = key.replace(/\.\d+$/, '');
		const claim: ReduceItem | undefined = result?.items.find(
			(proposal) => itemLineage(sourceKey, proposal) === base
		);
		if (!claim) continue;
		return {
			assertion: await sealBodyAtWrite(claim.assertion),
			display: await sealedPair(claim.display),
			due: claim.due,
			amount: claim.amount,
			options: claim.options,
			lineage: key,
		};
	}
	return null;
}

async function redactedItem(): Promise<ItemPatch> {
	return {
		assertion: await sealBodyAtWrite(REDACTED_CLAIM_TEXT.en),
		display: await sealedPair(REDACTED_CLAIM_TEXT),
		due: undefined,
		amount: undefined,
		options: undefined,
		lineage: undefined,
		isReviewNeeded: true,
	};
}

/** The fact's wording from a surviving source's claim of the same fact key, or null. */
async function restatedFact(
	ctx: MutationCtx,
	fact: Doc<'threadFacts'>,
	sourceKeys: readonly string[],
	budget: DrainBudget
): Promise<Partial<Doc<'threadFacts'>> | null> {
	for (const sourceKey of sourceKeys) {
		const result = await currentResult(ctx, sourceKey, budget);
		const claim: ReduceFact | undefined = result?.facts?.find((f) => f.key === fact.factKey);
		if (!claim) continue;
		return {
			assertion: await sealBodyAtWrite(claim.assertion),
			display: await sealedPair(claim.display),
			value: await sealedFactValue(claim.value),
			lineage: factLineage(sourceKey, claim),
		};
	}
	return null;
}

async function sealedFactValue(value: ReduceFact['value']): Promise<Doc<'threadFacts'>['value']> {
	if (!value) return undefined;
	if (value.kind === 'date' || value.kind === 'money') return value;
	return { kind: value.kind, text: await sealBodyAtWrite(value.text) };
}

async function redactedFact(): Promise<Partial<Doc<'threadFacts'>>> {
	return {
		assertion: await sealBodyAtWrite(REDACTED_CLAIM_TEXT.en),
		display: await sealedPair(REDACTED_CLAIM_TEXT),
		value: undefined,
		lineage: undefined,
	};
}
