/**
 * The stored claims that still support an item or fact after a purge
 * (review round 2, F4): every claim key that produced or merged into the row
 * (its `lineage` / `lineageKeys`, and the `interpretSources.claimIds` record
 * of every source its surviving evidence names), resolved against that
 * source's CURRENT extraction (`messageInterpretations.isCurrent`, sealed
 * payload), newest source first. A purged source is never consulted.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import { openMessageBody } from '../../lib/messageBody';
import type { DrainBudget } from './purgeDrain';
import type { ReduceFact, ReduceItem, ReduceResult } from './reduceInput';
import { factLineage, itemLineage } from './fold';

/** The purged sources, by id (evidence) and by key (lineage, extractions). */
export interface PurgedSources {
	ids: ReadonlySet<string>;
	keys: ReadonlySet<string>;
}

/** One surviving source's claim of a row, with its message date. */
export interface StoredClaim<T> {
	key: string;
	sourceKey: string;
	at: number;
	claim: T;
}

/** The source key a lineage or claim key starts with (`<sourceKey>#…`). Pure. */
export function lineageSource(lineage: string): string {
	const at = lineage.indexOf('#');
	return at < 0 ? lineage : lineage.slice(0, at);
}

/** A claim key without the `.n` suffix that tells identical proposals apart. Pure. */
function claimBase(key: string): string {
	return key.replace(/\.\d+$/, '');
}

/** A source's current extraction: its stored result and message date, or null. */
async function currentRead(
	ctx: MutationCtx,
	sourceKey: string,
	budget: DrainBudget
): Promise<{ result: ReduceResult; at: number } | null> {
	budget.range();
	const row = await ctx.db
		.query('messageInterpretations')
		.withIndex('by_source_current', (q) => q.eq('sourceKey', sourceKey).eq('isCurrent', true))
		.first();
	budget.charge(row);
	if (!row?.payload) return null;
	try {
		const result = JSON.parse(await openMessageBody(row.payload)) as ReduceResult;
		return { result, at: row.sourceAt ?? row.createdAt };
	} catch {
		return null;
	}
}

/**
 * Every claim key that names `rowId`: the row's own keys plus the claim
 * records of the sources its surviving evidence names. Purged keys excluded.
 */
async function claimKeysOf(
	ctx: MutationCtx,
	rowId: string,
	ownKeys: ReadonlyArray<string | undefined>,
	evidence: ReadonlyArray<{ source: Doc<'threadItems'>['evidence'][number]['source'] }>,
	purged: PurgedSources,
	budget: DrainBudget
): Promise<Set<string>> {
	const keys = new Set<string>();
	for (const key of ownKeys) if (key && !purged.keys.has(lineageSource(key))) keys.add(key);
	const sourceKeys = new Set(evidence.map((e) => interpretationSourceKey(e.source)));
	for (const sourceKey of sourceKeys) {
		if (purged.keys.has(sourceKey)) continue;
		budget.range();
		const record = await ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', sourceKey))
			.first();
		budget.charge(record);
		for (const entry of record?.claimIds ?? []) {
			if (entry.itemId === rowId || entry.factId === rowId) keys.add(entry.key);
		}
	}
	return keys;
}

/** Resolve claim keys against their sources' current reads, newest first. */
async function resolveClaims<T>(
	ctx: MutationCtx,
	keys: ReadonlySet<string>,
	budget: DrainBudget,
	pick: (result: ReduceResult, sourceKey: string, base: string) => T | undefined
): Promise<StoredClaim<T>[]> {
	const bySource = new Map<string, string[]>();
	for (const key of keys) {
		const sourceKey = lineageSource(key);
		bySource.set(sourceKey, [...(bySource.get(sourceKey) ?? []), key]);
	}
	const claims: StoredClaim<T>[] = [];
	for (const [sourceKey, sourceKeys] of bySource) {
		const read = await currentRead(ctx, sourceKey, budget);
		if (!read) continue;
		for (const key of sourceKeys) {
			const claim = pick(read.result, sourceKey, claimBase(key));
			if (claim) claims.push({ key, sourceKey, at: read.at, claim });
		}
	}
	return claims.sort((a, b) => b.at - a.at);
}

/** The surviving stored claims of an item, newest source first. */
export async function survivingItemClaims(
	ctx: MutationCtx,
	item: Doc<'threadItems'>,
	evidence: Doc<'threadItems'>['evidence'],
	purged: PurgedSources,
	budget: DrainBudget
): Promise<StoredClaim<ReduceItem>[]> {
	const keys = await claimKeysOf(
		ctx,
		item._id,
		[item.lineage, ...(item.lineageKeys ?? [])],
		evidence,
		purged,
		budget
	);
	return resolveClaims(ctx, keys, budget, (result, sourceKey, base) =>
		result.items.find((claim) => itemLineage(sourceKey, claim) === base)
	);
}

/**
 * The surviving stored claims of a fact, newest source first. A fact without
 * a claim record falls back to the same fact key in the current reads of the
 * sources its surviving evidence names.
 */
export async function survivingFactClaims(
	ctx: MutationCtx,
	fact: Doc<'threadFacts'>,
	evidence: Doc<'threadFacts'>['evidence'],
	purged: PurgedSources,
	budget: DrainBudget
): Promise<StoredClaim<ReduceFact>[]> {
	const keys = await claimKeysOf(ctx, fact._id, [fact.lineage], evidence, purged, budget);
	const claims = await resolveClaims(ctx, keys, budget, (result, sourceKey, base) =>
		result.facts?.find((claim) => factLineage(sourceKey, claim) === base)
	);
	if (claims.length > 0) return claims;
	const fallback = new Set(
		evidence
			.map((e) => interpretationSourceKey(e.source))
			.filter((key) => !purged.keys.has(key))
			.map((sourceKey) => `${sourceKey}#bykey`)
	);
	return resolveClaims(ctx, fallback, budget, (result) =>
		result.facts?.find((claim) => claim.key === fact.factKey)
	);
}
