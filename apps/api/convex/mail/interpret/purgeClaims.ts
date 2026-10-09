/**
 * One claim (item or fact) under a message purge (review rounds 1–2, F3–F5):
 *
 *  - the evidence entries that name a purged source go;
 *  - a claim left without evidence is `doomed`: the caller clears its links
 *    (`purgeLinks.ts`) and deletes it;
 *  - a claim that survives is REBUILT field by field from the stored claims
 *    that still support it (`purgeClaimSources.ts`): its text from the
 *    newest surviving source's claim, and every extracted value (item: due,
 *    amount, options; fact: value) from the newest surviving claim that
 *    states it. A field no surviving claim states is dropped; with no
 *    surviving claim at all, text the purged message wrote is redacted to a
 *    neutral line ("Details removed with the deleted message") and review is
 *    flagged. So a value only a purged message supplied never outlives it;
 *  - an unconfirmed held update (`pendingUpdate`) that a purged source
 *    supported goes whole, and so does the confirmation undo snapshot
 *    (`confirmedFrom`) of any claim the purge touched: its saved values
 *    could otherwise restore what the purged message said;
 *  - a status or disposition the purged source set, as a message or as a
 *    recorded operation on it (a bounced send: `op:<sourceKey>`), goes back
 *    to `open` / `unanswered` with review flagged
 *    (`transitionSources.ts resetTransitionsFrom`); what a person or another
 *    source set stays.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { writeItemChange } from './counters';
import type { DrainBudget } from './purgeDrain';
import type { ReduceFact, ReduceItem } from './reduceInput';
import { resetTransitionsFrom } from './transitionSources';
import { factLineage } from './fold';
import {
	lineageSource,
	survivingFactClaims,
	survivingItemClaims,
	type PurgedSources,
	type StoredClaim,
} from './purgeClaimSources';

export { lineageSource, type PurgedSources } from './purgeClaimSources';
import { isHolding, revertPurgedConfirmation, withoutSources } from './heldSources';

/** The neutral line a claim whose wording came from a purged message shows. */
export const REDACTED_CLAIM_TEXT = {
	en: 'Details removed with the deleted message',
	de: 'Details mit der gelöschten Nachricht entfernt',
} as const;

export type ClaimFate = 'untouched' | 'doomed' | 'survived';

/** An item patch as the counters' item write takes it. */
type ItemPatch = Parameters<typeof writeItemChange>[3];

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

/** The newest claim in `claims` (newest first) that states `field`. Pure. */
function newestWith<T, K extends keyof T>(
	claims: readonly StoredClaim<T>[],
	field: K
): T[K] | undefined {
	return claims.find((c) => c.claim[field] !== undefined && c.claim[field] !== null)?.claim[field];
}

async function sealedPair(text: { en: string; de: string }) {
	return { en: await sealBodyAtWrite(text.en), de: await sealBodyAtWrite(text.de) };
}

/** An item's fields rebuilt from its surviving claims (newest first). */
async function rebuiltItem(
	item: Doc<'threadItems'>,
	claims: readonly StoredClaim<ReduceItem>[],
	purged: PurgedSources
): Promise<ItemPatch> {
	const newest = claims[0];
	const values: ItemPatch = {
		due: newestWith(claims, 'due') ?? undefined,
		amount: newestWith(claims, 'amount') ?? undefined,
		options: newestWith(claims, 'options') ?? undefined,
	};
	if (newest) {
		return {
			...values,
			assertion: await sealBodyAtWrite(newest.claim.assertion),
			display: await sealedPair(newest.claim.display),
			lineage: newest.key,
		};
	}
	// No surviving claim states anything: text the purged message wrote goes,
	// and no value stands without a claim behind it.
	return {
		...values,
		...(isWordingPurged(item, purged)
			? {
					assertion: await sealBodyAtWrite(REDACTED_CLAIM_TEXT.en),
					display: await sealedPair(REDACTED_CLAIM_TEXT),
					lineage: undefined,
				}
			: {}),
		isReviewNeeded: true,
	};
}

/** Strip one item; a survivor is rebuilt and written through the counters' item write. */
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
	// A confirmation that applied parties the purged message proposed: put back.
	const reverted = revertPurgedConfirmation(item, purged.keys);
	const pendingEvidence = pending?.evidence.filter((e) => !purged.ids.has(e.source.id)) ?? [];
	const held = isPendingNamed
		? { pendingUpdate: strippedHeld(pending!, pendingEvidence, purged) }
		: {};
	if (!names(item.evidence)) {
		// No evidence of the purged source, but a status or disposition it set
		// (a bounced send's `failed` names the send, not the item's evidence),
		// or held changes or a confirmation it proposed.
		const reset = transitionReset(item, purged);
		if (!reset && !isPendingNamed && !reverted) return 'untouched';
		await writeItemChange(ctx, ref, item, {
			...reset,
			...held,
			...reverted?.patch,
			...(item.confirmedFrom && (reverted || isPendingNamed) ? { confirmedFrom: undefined } : {}),
			revision: item.revision + 1,
			updatedAt: Date.now(),
		});
		return 'survived';
	}
	const evidence = item.evidence.filter((e) => !purged.ids.has(e.source.id));
	if (evidence.length === 0) return 'doomed';

	const claims = await survivingItemClaims(ctx, item, evidence, purged, budget);
	const patch: ItemPatch = {
		evidence,
		...reverted?.patch,
		...(await rebuiltItem(item, claims, purged)),
		...held,
		...(item.confirmedFrom ? { confirmedFrom: undefined } : {}),
		...(item.lineageKeys
			? { lineageKeys: item.lineageKeys.filter((k) => !purged.keys.has(lineageSource(k))) }
			: {}),
		...transitionReset(item, purged),
		revision: item.revision + 1,
		updatedAt: Date.now(),
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

async function sealedFactValue(value: ReduceFact['value']): Promise<Doc<'threadFacts'>['value']> {
	if (!value) return undefined;
	if (value.kind === 'date' || value.kind === 'money') return value;
	return { kind: value.kind, text: await sealBodyAtWrite(value.text) };
}

/** Strip one fact (mail threads only); a survivor is rebuilt from its surviving claims. */
export async function stripFact(
	ctx: MutationCtx,
	fact: Doc<'threadFacts'>,
	purged: PurgedSources,
	budget: DrainBudget
): Promise<ClaimFate> {
	if (!fact.evidence.some((e) => purged.ids.has(e.source.id))) return 'untouched';
	const evidence = fact.evidence.filter((e) => !purged.ids.has(e.source.id));
	if (evidence.length === 0) return 'doomed';
	const claims = await survivingFactClaims(ctx, fact, evidence, purged, budget);
	const newest = claims[0];
	const patch: Partial<Doc<'threadFacts'>> = {
		evidence,
		value: await sealedFactValue(newestWith(claims, 'value') ?? undefined),
		...(newest
			? {
					assertion: await sealBodyAtWrite(newest.claim.assertion),
					display: await sealedPair(newest.claim.display),
					lineage: newest.key.endsWith('#bykey')
						? factLineage(newest.sourceKey, newest.claim)
						: newest.key,
				}
			: isWordingPurged(fact, purged)
				? {
						assertion: await sealBodyAtWrite(REDACTED_CLAIM_TEXT.en),
						display: await sealedPair(REDACTED_CLAIM_TEXT),
						lineage: undefined,
					}
				: {}),
		revision: fact.revision + 1,
		updatedAt: Date.now(),
	};
	await ctx.db.patch(fact._id, patch);
	return 'survived';
}
