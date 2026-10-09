/**
 * One claim (item or fact) under a message purge (review round 3, rule P):
 *
 *  - the evidence entries that name a purged source go;
 *  - a claim left without evidence is `doomed`: the caller clears its links
 *    (`purgeLinks.ts`) and deletes it;
 *  - a claim that survives on other evidence is REDACTED: exactly the shown
 *    fields the purged message set go (`threadItems.fieldSources`, read by
 *    `heldSources.redactSourcedFields`, interpret round 8): the wording
 *    becomes the neutral line ("Details removed with the deleted message"),
 *    parties become unknown (no address, no name) with responsibility
 *    `unclear` and the counterparty recomputed, deadline, amount and options
 *    are cleared. An item written before `fieldSources` existed is redacted
 *    conservatively: every extracted value a person did not confirm. Facets
 *    and consequences go with purged wording unless a surviving source's
 *    claim record still names the item. A fact loses its text and value. The
 *    redacted fields are listed in `redactedFields`, review is flagged, and
 *    the thread is re-read from its surviving sources (`purge.ts`
 *    `reinterpretRange`): a verified claim then refills the fields directly
 *    (`reducePlan.ts` / `reducePlanFacts.ts` read the marker);
 *  - what a person confirmed (correction `confirmed`) stays, as do the
 *    status, assignee and reminder a person set;
 *  - a held update (`pendingUpdate`) loses exactly the fields, removals and
 *    transitions a purged source proposed (`heldSources.ts`, per-field
 *    provenance), a confirmation that applied a purged source's parties is
 *    reverted, and the undo snapshot (`confirmedFrom`) goes when the purge
 *    touched what it would restore;
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
import { isHolding, redactSourcedFields, withoutSources } from './heldSources';

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

type RedactedItemField = (typeof REDACTED_ITEM_FIELDS)[number];

/** An item's `fieldSources` field → the item fields it covers. */
const SOURCED_FIELDS: Record<string, readonly RedactedItemField[]> = {
	wording: ['assertion', 'display'],
	requester: ['requester'],
	responsible: ['responsible', 'responsibility'],
	beneficiary: ['beneficiary'],
	responsibility: ['responsibility'],
	due: ['due'],
	amount: ['amount'],
	options: ['options'],
};

/**
 * The redaction of a surviving item (rule P), ONE path for every purge:
 * with per-field provenance (`fieldSources`) exactly the fields the purged
 * sources set, through `heldSources.redactSourcedFields` (parties unknown,
 * counterparty recomputed, provenance pruned); without it (an item written
 * before round 8) every extracted value, unless a person confirmed the item.
 * Null when nothing shown came from the purged sources.
 */
async function itemRedaction(
	ctx: MutationCtx,
	item: Doc<'threadItems'>,
	purged: PurgedSources,
	evidence: Doc<'threadItems'>['evidence'],
	budget: DrainBudget,
	opts: { isLegacyRedacted: boolean }
): Promise<ItemPatch | null> {
	let fields: RedactedItemField[];
	let patch: ItemPatch;
	if (item.fieldSources) {
		const sourced = redactSourcedFields(item, purged.keys);
		if (!sourced) return null;
		fields = [
			...new Set(
				Object.keys(item.fieldSources)
					.filter((f) =>
						purged.keys.has(item.fieldSources![f as keyof typeof item.fieldSources]!.sourceKey)
					)
					.flatMap((f) => SOURCED_FIELDS[f] ?? [])
			),
		];
		patch = { ...sourced.patch };
	} else {
		if (!opts.isLegacyRedacted || item.correction?.kind === 'confirmed') return null;
		fields = [...REDACTED_ITEM_FIELDS];
		const unknown = { isUs: false };
		patch = {
			requester: unknown,
			responsible: unknown,
			beneficiary: undefined,
			responsibility: 'unclear',
			counterpartyKey: undefined,
			due: undefined,
			amount: undefined,
			options: undefined,
		};
	}
	const isWordingGone = fields.includes('assertion');
	const isFacetsKept =
		!isWordingGone || (await isNamedBySurvivingRecord(ctx, item._id, evidence, budget));
	return {
		...patch,
		...(isWordingGone
			? {
					assertion: await sealBodyAtWrite(REDACTED_CLAIM_TEXT.en),
					display: await sealedPair(REDACTED_CLAIM_TEXT),
				}
			: {}),
		...(isFacetsKept ? {} : { facets: [], consequences: undefined }),
		redactedFields: [
			...new Set([
				...(item.redactedFields ?? []),
				...fields,
				...(isFacetsKept ? [] : ['facets', 'consequences']),
			]),
		],
		isReviewNeeded: true,
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
	const names = (list: ReadonlyArray<{ source: { id: string } }>) =>
		list.some((e) => purged.ids.has(e.source.id));
	const pending = item.pendingUpdate;
	// A held field or transition names its source even without quotes (interpret round 7 F1).
	const isPendingNamed =
		!!pending &&
		(names(pending.evidence) ||
			(pending.fieldSources ?? []).some((f) => purged.keys.has(f.sourceKey)) ||
			(pending.transitions ?? []).some((t) => purged.keys.has(t.sourceKey)));
	const evidence = item.evidence.filter((e) => !purged.ids.has(e.source.id));
	const isNamedByEvidence = evidence.length < item.evidence.length;
	if (isNamedByEvidence && evidence.length === 0) return 'doomed';
	// Rule P: the shown fields the purged sources set (one path, see itemRedaction).
	const redaction = await itemRedaction(ctx, item, purged, evidence, budget, {
		isLegacyRedacted: isNamedByEvidence,
	});
	const pendingEvidence = pending?.evidence.filter((e) => !purged.ids.has(e.source.id)) ?? [];
	const held = isPendingNamed
		? { pendingUpdate: strippedHeld(pending!, pendingEvidence, purged) }
		: {};
	const isSnapshotGone =
		isSnapshotPurged(item.confirmedFrom, purged) || !!redaction || isPendingNamed;
	const snapshot = item.confirmedFrom && isSnapshotGone ? { confirmedFrom: undefined } : {};
	const reset = transitionReset(item, purged);
	const stamp = { revision: item.revision + 1, updatedAt: Date.now() };
	if (!isNamedByEvidence) {
		// No evidence of the purged source, but a status or disposition it set
		// (a bounced send's `failed` names the send, not the item's evidence),
		// held changes, a confirmation or a shown field it proposed.
		if (!reset && !isPendingNamed && !redaction) return 'untouched';
		await writeItemChange(ctx, ref, item, {
			...reset,
			...held,
			...redaction,
			...snapshot,
			...stamp,
		});
		return 'survived';
	}

	const patch: ItemPatch = {
		evidence,
		...redaction,
		...held,
		...snapshot,
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
